use std::{collections::BTreeSet, sync::Arc};

use tokio::time::Instant;
use world_protocol::ids::{PluginGenerationId, WorldRef, WriterEpoch};

use super::{
    LifecycleError, LiveExtensions, PreparedGraph,
    live::{LiveGraph, Registry, drain_graph},
};
use crate::{
    extensions::{
        bindings::{GateAccess, PreparedTransfer},
        invocation::{Admission, DrainOutcome, LedgerSnapshot, ResourceLedger},
    },
    store::{
        SourceResumeReceipt, SourceRetirementReceipt, TargetActivationReceipt, TransferCut,
        TransferDraining, WorldSnapshot,
    },
};

pub(super) struct TransferFence {
    cut: TransferCut,
    identity: Arc<()>,
    hydration: Option<Arc<TransferHydration>>,
    applied: bool,
}

/// Selects accepted work for the original transfer; it does not prove task drain.
#[derive(Clone)]
pub(crate) struct AcceptedTransferSelection {
    origin: Arc<()>,
    fence: Arc<()>,
    cut: TransferCut,
}

impl AcceptedTransferSelection {
    pub fn cut(&self) -> &TransferCut {
        &self.cut
    }

    pub fn world(&self) -> &WorldRef {
        &self.cut.world
    }
}

#[must_use = "checkpoint and join accepted work before draining extension generations"]
pub(crate) struct ClosingTransfer {
    live: Arc<LiveExtensions>,
    fence: Arc<()>,
    cut: TransferCut,
    graphs: Vec<Arc<LiveGraph>>,
    generations: Vec<ResourceLedger>,
}

/// Proves only the old extension generations drained, not independent root or sync tasks.
#[must_use]
pub(crate) struct DrainedTransfer {
    live: Arc<LiveExtensions>,
    fence: Arc<()>,
    cut: TransferCut,
    generations: BTreeSet<PluginGenerationId>,
}

impl ClosingTransfer {
    pub fn cut(&self) -> &TransferCut {
        &self.cut
    }

    pub fn world(&self) -> &WorldRef {
        &self.cut.world
    }

    pub async fn drain_until(
        self,
        deadline: Instant,
    ) -> Result<DrainedTransfer, (Self, Vec<LedgerSnapshot>)> {
        for ledger in &self.generations {
            let _ = ledger.request_cancel();
        }
        let mut remaining = futures_util::future::join_all(
            self.graphs.iter().map(|graph| drain_graph(graph, deadline)),
        )
        .await
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        for ledger in &self.generations {
            if !matches!(
                ledger.drain_until(deadline).await,
                Ok(DrainOutcome::Drained)
            ) {
                let snapshot = ledger.snapshot();
                if !remaining
                    .iter()
                    .any(|other| other.generation == snapshot.generation)
                {
                    remaining.push(snapshot);
                }
            }
        }
        if !remaining.is_empty() {
            return Err((self, remaining));
        }
        let generations = self.live.gate.synchronized(|_| {
            let registry = self
                .live
                .registry
                .lock()
                .expect("world extension registry poisoned");
            if !transfer_matches(&registry, &self.cut, &self.fence)
                || registry
                    .transfers
                    .get(&self.cut.world)
                    .is_some_and(|fence| fence.hydration.is_some())
            {
                return None;
            }
            let generations = registry
                .generations
                .iter()
                .filter(|(_, generation)| generation.world == self.cut.world)
                .collect::<Vec<_>>();
            if generations
                .iter()
                .any(|(_, generation)| generation.ledger.snapshot().admission != Admission::Closed)
            {
                return None;
            }
            Some(generations.into_iter().map(|(id, _)| id.clone()).collect())
        });
        let Some(generations) = generations else {
            return Err((self, Vec::new()));
        };
        Ok(DrainedTransfer {
            live: self.live,
            fence: self.fence,
            cut: self.cut,
            generations,
        })
    }
}

impl DrainedTransfer {
    pub fn cut(&self) -> &TransferCut {
        &self.cut
    }

    pub fn world(&self) -> &WorldRef {
        &self.cut.world
    }

    pub fn validate(&self) -> bool {
        self.live.validate_transfer_drained(self)
    }
}

enum Completion {
    Target {
        activation: Arc<TargetActivationReceipt>,
        retirement: Arc<SourceRetirementReceipt>,
    },
    Source(Arc<SourceResumeReceipt>),
}

/// Fresh preparation authority, minted only from drained custody and original durable completion.
#[must_use]
pub(crate) struct TransferHydration {
    origin: Arc<()>,
    fence: Arc<()>,
    cut: TransferCut,
    completion: Completion,
}

impl TransferHydration {
    pub fn cut(&self) -> &TransferCut {
        &self.cut
    }

    pub fn world(&self) -> &WorldRef {
        &self.cut.world
    }

    pub fn storage_id(&self) -> &str {
        match &self.completion {
            Completion::Target { .. } => &self.cut.target_storage_id,
            Completion::Source(_) => &self.cut.source_storage_id,
        }
    }

    pub fn writer_epoch(&self) -> WriterEpoch {
        match &self.completion {
            Completion::Target { .. } => self.cut.target_epoch,
            Completion::Source(resumed) => resumed.writer_epoch(),
        }
    }

    pub async fn recheck_read(&self, snapshot: &WorldSnapshot<'_>) -> Result<(), LifecycleError> {
        match &self.completion {
            Completion::Target {
                activation,
                retirement,
            } => {
                if retirement.cut() != activation.cut()
                    || retirement.manifest_digest() != activation.manifest_digest()
                {
                    return Err(LifecycleError::InvalidPersistedState);
                }
                activation.recheck_read(snapshot).await?;
            }
            Completion::Source(resumed) => resumed.recheck_read(snapshot).await?,
        }
        Ok(())
    }
}

fn transfer_matches(registry: &Registry, cut: &TransferCut, identity: &Arc<()>) -> bool {
    registry.closing_worlds.contains(&cut.world)
        && !registry.stopped_worlds.contains(&cut.world)
        && registry.transfers.get(&cut.world).is_some_and(|fence| {
            !fence.applied && fence.cut == *cut && Arc::ptr_eq(&fence.identity, identity)
        })
}

impl Registry {
    pub(super) fn transfer_closing(&self, world: &WorldRef) -> bool {
        self.transfers
            .get(world)
            .is_some_and(|fence| !fence.applied)
    }
}

impl LiveExtensions {
    pub fn begin_transfer(
        self: &Arc<Self>,
        intent: &TransferDraining,
    ) -> Result<ClosingTransfer, LifecycleError> {
        self.gate.synchronized(|_| {
            let mut registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            let cut = intent.cut();
            if registry.stopped_worlds.contains(&cut.world) {
                return Err(LifecycleError::Retiring);
            }
            let identity = if let Some(fence) = registry.transfers.get(&cut.world) {
                if fence.cut == *cut {
                    if fence.applied || fence.hydration.is_some() {
                        return Err(LifecycleError::Retiring);
                    }
                    fence.identity.clone()
                } else if fence.applied && !registry.closing_worlds.contains(&cut.world) {
                    Arc::new(())
                } else {
                    return Err(LifecycleError::Retiring);
                }
            } else {
                if registry.closing_worlds.contains(&cut.world) {
                    return Err(LifecycleError::Retiring);
                }
                Arc::new(())
            };
            registry.transfers.insert(
                cut.world.clone(),
                TransferFence {
                    cut: cut.clone(),
                    identity: identity.clone(),
                    hydration: None,
                    applied: false,
                },
            );
            registry.close_world(&cut.world, false);
            let graphs = registry
                .candidates
                .iter()
                .chain(&registry.failed)
                .chain(&registry.previous)
                .chain(registry.exact.values())
                .filter(|graph| graph.graph.lock().world == cut.world)
                .cloned()
                .collect();
            let generations = registry
                .generations
                .values()
                .filter(|generation| generation.world == cut.world)
                .map(|generation| generation.ledger.clone())
                .collect();
            Ok(ClosingTransfer {
                live: self.clone(),
                fence: identity,
                cut: cut.clone(),
                graphs,
                generations,
            })
        })
    }

    pub fn accepted_transfer(
        &self,
        closing: &ClosingTransfer,
    ) -> Result<AcceptedTransferSelection, LifecycleError> {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            if !Arc::ptr_eq(&self.identity, &closing.live.identity)
                || !transfer_matches(&registry, &closing.cut, &closing.fence)
            {
                return Err(LifecycleError::Retiring);
            }
            Ok(AcceptedTransferSelection {
                origin: self.identity.clone(),
                fence: closing.fence.clone(),
                cut: closing.cut.clone(),
            })
        })
    }

    pub fn validate_accepted_transfer(&self, proof: &AcceptedTransferSelection) -> bool {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            Arc::ptr_eq(&self.identity, &proof.origin)
                && transfer_matches(&registry, &proof.cut, &proof.fence)
        })
    }

    pub fn validate_transfer_drained(&self, proof: &DrainedTransfer) -> bool {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            Arc::ptr_eq(&self.identity, &proof.live.identity)
                && transfer_matches(&registry, &proof.cut, &proof.fence)
                && proof.generations.iter().all(|id| {
                    registry.generations.get(id).is_some_and(|generation| {
                        generation.world == proof.cut.world
                            && generation.ledger.snapshot().admission == Admission::Closed
                    })
                })
                && registry.generations.iter().all(|(id, generation)| {
                    generation.world != proof.cut.world
                        || proof.generations.contains(id)
                        || generation.binding().is_some_and(|binding| {
                            binding.transfer.as_ref().is_some_and(|hydration| {
                                hydration.cut == proof.cut
                                    && Arc::ptr_eq(&hydration.fence, &proof.fence)
                            })
                        })
                })
        })
    }

    pub fn transfer_applied(&self, cut: &TransferCut) -> bool {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            !registry.stopped_worlds.contains(&cut.world)
                && !registry.closing_worlds.contains(&cut.world)
                && registry
                    .transfers
                    .get(&cut.world)
                    .is_some_and(|fence| fence.cut == *cut && fence.applied)
        })
    }

    pub fn transfer_applied_in(&self, access: &GateAccess<'_>, proof: &TransferHydration) -> bool {
        assert!(access.belongs_to(&self.gate));
        let registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        Arc::ptr_eq(&self.identity, &proof.origin)
            && !registry.stopped_worlds.contains(proof.world())
            && !registry.closing_worlds.contains(proof.world())
            && registry.transfers.get(proof.world()).is_some_and(|fence| {
                fence.applied
                    && fence.cut == proof.cut
                    && Arc::ptr_eq(&fence.identity, &proof.fence)
            })
    }

    pub fn hydrate_transfer_target(
        &self,
        drained: &DrainedTransfer,
        activation: Arc<TargetActivationReceipt>,
        retirement: Arc<SourceRetirementReceipt>,
    ) -> Result<Arc<TransferHydration>, LifecycleError> {
        if activation.cut() != drained.cut()
            || retirement.cut() != drained.cut()
            || activation.manifest_digest() != retirement.manifest_digest()
        {
            return Err(LifecycleError::InvalidPersistedState);
        }
        self.hydrate_transfer(
            drained,
            Completion::Target {
                activation,
                retirement,
            },
        )
    }

    pub fn hydrate_transfer_source(
        &self,
        drained: &DrainedTransfer,
        resumed: Arc<SourceResumeReceipt>,
    ) -> Result<Arc<TransferHydration>, LifecycleError> {
        if resumed.cut() != drained.cut()
            || resumed.writer_epoch().0 <= drained.cut().target_epoch.0
        {
            return Err(LifecycleError::InvalidPersistedState);
        }
        self.hydrate_transfer(drained, Completion::Source(resumed))
    }

    fn hydrate_transfer(
        &self,
        drained: &DrainedTransfer,
        completion: Completion,
    ) -> Result<Arc<TransferHydration>, LifecycleError> {
        if !self.validate_transfer_drained(drained) {
            return Err(LifecycleError::Retiring);
        }
        self.gate.synchronized(|_| {
            let mut registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            if !transfer_matches(&registry, &drained.cut, &drained.fence) {
                return Err(LifecycleError::Retiring);
            }
            let fence = registry
                .transfers
                .get_mut(&drained.cut.world)
                .expect("validated transfer fence");
            if let Some(held) = &fence.hydration {
                let same = match (&held.completion, &completion) {
                    (
                        Completion::Target { activation: a, .. },
                        Completion::Target { activation: b, .. },
                    ) => a.cut() == b.cut() && a.manifest_digest() == b.manifest_digest(),
                    (Completion::Source(a), Completion::Source(b)) => {
                        a.cut() == b.cut() && a.writer_epoch() == b.writer_epoch()
                    }
                    _ => false,
                };
                return if same {
                    Ok(held.clone())
                } else {
                    Err(LifecycleError::InvalidPersistedState)
                };
            }
            let proof = Arc::new(TransferHydration {
                origin: self.identity.clone(),
                fence: drained.fence.clone(),
                cut: drained.cut.clone(),
                completion,
            });
            fence.hydration = Some(proof.clone());
            Ok(proof)
        })
    }

    pub(super) fn require_transfer_hydration(
        &self,
        registry: &Registry,
        proof: &TransferHydration,
    ) -> Result<(), LifecycleError> {
        if !Arc::ptr_eq(&self.identity, &proof.origin)
            || !transfer_matches(registry, &proof.cut, &proof.fence)
            || registry
                .transfers
                .get(&proof.cut.world)
                .and_then(|fence| fence.hydration.as_ref())
                .is_none_or(|held| !std::ptr::eq(held.as_ref(), proof))
            || registry.generations.values().any(|generation| {
                generation.world == proof.cut.world
                    && generation.ledger.snapshot().admission != Admission::Closed
                    && generation.binding().is_none_or(|binding| {
                        binding.transfer.as_ref().is_none_or(|held| !std::ptr::eq(held.as_ref(), proof))
                    })
            })
        {
            return Err(LifecycleError::Retiring);
        }
        Ok(())
    }

    pub fn validate_transfer_hydration(&self, proof: &TransferHydration) -> bool {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            self.require_transfer_hydration(&registry, proof).is_ok()
        })
    }

    pub fn publish_transfer(
        &self,
        access: &GateAccess<'_>,
        proof: &TransferHydration,
        graphs: &mut Vec<PreparedGraph>,
        selection: &PreparedTransfer,
    ) -> Result<(), LifecycleError> {
        assert!(access.belongs_to(&self.gate));
        let mut registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        self.require_transfer_hydration(&registry, proof)?;
        if selection.world() != proof.world()
            || selection.cut() != proof.cut()
            || !selection.matches_hydration(proof)
        {
            return Err(LifecycleError::InvalidPersistedState);
        }
        let mut locks = BTreeSet::new();
        let mut generations = BTreeSet::new();
        for prepared in graphs.iter() {
            let graph = prepared.graph();
            if &graph.lock().world != proof.world()
                || !locks.insert(graph.lock().id.clone())
                || registry
                    .retired
                    .contains(&(proof.world().clone(), graph.lock().id.clone()))
                || !registry
                    .candidates
                    .iter()
                    .any(|candidate| Arc::ptr_eq(candidate, &prepared.inner))
            {
                return Err(LifecycleError::InvalidPersistedState);
            }
            access
                .require_lock_open(proof.world(), &graph.lock().id)
                .map_err(LifecycleError::Gate)?;
            let heads = prepared
                .channels()
                .iter()
                .map(|mapping| mapping.channel.clone())
                .collect::<Vec<_>>();
            let domains = graph
                .lock()
                .nodes
                .iter()
                .filter_map(|node| node.state.as_ref().map(|state| state.writer_domain.clone()))
                .collect::<Vec<_>>();
            access
                .require_open(proof.world(), &heads, &domains)
                .map_err(LifecycleError::Gate)?;
            for node in prepared.inner.nodes.values() {
                let snapshot = node.ledger.snapshot();
                let generation = registry
                    .generations
                    .get(&snapshot.generation)
                    .ok_or(LifecycleError::InvalidPersistedState)?;
                if snapshot.admission != Admission::Open
                    || !generations.insert(snapshot.generation)
                    || generation.binding().is_none_or(|binding| {
                        binding.transfer.as_ref().is_none_or(|held| !std::ptr::eq(held.as_ref(), proof))
                    })
                    || !generation.ledger.same_instance(&node.ledger)
                    || registry
                        .install_fences
                        .get(&(proof.world().clone(), generation.install.clone()))
                        .is_some_and(|fence| fence.closing)
                {
                    return Err(LifecycleError::Retiring);
                }
            }
        }
        if registry.generations.iter().any(|(id, generation)| {
            &generation.world == proof.world()
                && !generations.contains(id)
                && generation.ledger.snapshot().admission != Admission::Closed
        }) || selection.required_graphs().any(|required| {
            !graphs
                .iter()
                .any(|fresh| fresh.graph().lock() == required.lock())
        }) {
            return Err(LifecycleError::Retiring);
        }
        registry
            .exact
            .retain(|(world, _), _| world != proof.world());
        registry
            .previous
            .retain(|graph| &graph.graph.lock().world != proof.world());
        registry
            .failed
            .retain(|graph| &graph.graph.lock().world != proof.world());
        registry
            .candidates
            .retain(|graph| &graph.graph.lock().world != proof.world());
        registry.generations.retain(|id, generation| {
            &generation.world != proof.world() || generations.contains(id)
        });
        for prepared in graphs.drain(..) {
            registry.exact.insert(
                (proof.world().clone(), prepared.graph().lock().id.clone()),
                prepared.inner,
            );
        }
        let fence = registry
            .transfers
            .get_mut(proof.world())
            .expect("validated transfer fence");
        fence.applied = true;
        fence.hydration = None;
        registry.closing_worlds.remove(proof.world());
        Ok(())
    }
}
