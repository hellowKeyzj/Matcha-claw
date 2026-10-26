use std::{collections::BTreeSet, sync::Arc};

use tokio::time::Instant;
use world_protocol::ids::{ActivationLockId, Digest, PluginGenerationId, WorldRef};

use super::{
    LifecycleError, LiveExtensions,
    live::{LiveGraph, Registry, drain_graph},
};
use crate::extensions::{
    bindings::{BindingGraph, CommittedRetirement, GateAccess},
    invocation::{DrainOutcome, LedgerSnapshot, ResourceLedger},
};

#[must_use = "keep retirement custody and retry until every generation is actually drained"]
pub(crate) struct RetiringGraph {
    origin: Arc<()>,
    world: WorldRef,
    lock: ActivationLockId,
    digest: Digest,
    graphs: Vec<Arc<LiveGraph>>,
    generations: Vec<(PluginGenerationId, ResourceLedger)>,
}

/// This capability proves resource drain, never the absence of durable pins.
#[must_use = "consume with the durable owner that checks all persistent retention pins"]
pub(crate) struct DrainedGraph {
    origin: Arc<()>,
    world: WorldRef,
    lock: ActivationLockId,
    digest: Digest,
    generations: Vec<PluginGenerationId>,
    process_failures: Vec<Arc<crate::extensions::process::ProcessError>>,
}

impl DrainedGraph {
    pub fn world(&self) -> &WorldRef {
        &self.world
    }
    pub fn lock(&self) -> &ActivationLockId {
        &self.lock
    }
    pub fn digest(&self) -> &Digest {
        &self.digest
    }
    pub fn generations(&self) -> &[PluginGenerationId] {
        &self.generations
    }
    pub fn process_failures(&self) -> &[Arc<crate::extensions::process::ProcessError>] {
        &self.process_failures
    }
}

impl LiveExtensions {
    pub fn validate_drained(&self, proof: &DrainedGraph) -> bool {
        Arc::ptr_eq(&self.identity, &proof.origin)
    }

    /// Pure preflight inside the original retirement publication reservation.
    pub fn preflight_retirement_in(
        &self,
        access: &GateAccess<'_>,
        graph: &BindingGraph,
    ) -> Result<(), LifecycleError> {
        assert!(access.belongs_to(&self.gate));
        access
            .require_lock_open(&graph.lock().world, &graph.lock().id)
            .map_err(LifecycleError::Gate)?;
        let registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        let graphs = retirement_graphs(&registry, graph)?;
        let held = registry.generations.values()
            .filter(|generation| generation.world == graph.lock().world
                && generation.binding().is_some_and(|binding| binding.lock == graph.lock().id))
            .map(|generation| generation.ledger.snapshot())
            .filter(|snapshot| snapshot.invocation_inflight != 0)
            .collect::<Vec<_>>();
        if !held.is_empty() {
            return Err(LifecycleError::Contract(world_protocol::lifecycle::LifecycleFailure::Retained {
                stage: world_protocol::lifecycle::LifecycleStage::CloseAcquisition,
                remaining_resources: held.iter().flat_map(super::retained_resources).collect(),
            }));
        }
        let mut heads = BTreeSet::new();
        let mut domains = BTreeSet::new();
        for live in graphs {
            for root in &live.graph.lock().roots {
                let closure = live
                    .graph
                    .exact_closure(root, &live.channels)
                    .map_err(|_| LifecycleError::InvalidPersistedState)?;
                heads.extend(closure.affected_heads);
                domains.extend(closure.affected_domains);
            }
        }
        access
            .require_open(
                &graph.lock().world,
                &heads.into_iter().collect::<Vec<_>>(),
                &domains.into_iter().collect::<Vec<_>>(),
            )
            .map_err(LifecycleError::Gate)
    }

    /// Called only in the original authoritative release publication callback.
    pub fn release_retirement_in(
        &self,
        access: &GateAccess<'_>,
        proof: &DrainedGraph,
    ) -> Result<(), LifecycleError> {
        assert!(access.belongs_to(&self.gate));
        if !self.validate_drained(proof) {
            return Err(LifecycleError::InvalidPersistedState);
        }
        let mut registry = self.registry.lock().expect("world extension registry poisoned");
        let key = (proof.world.clone(), proof.lock.clone());
        if !registry.retired.contains(&key)
            || registry.candidates.iter().any(|live| {
                live.graph.lock().world == key.0 && live.graph.lock().id == key.1
            })
            || registry.exact.values().chain(&registry.previous).chain(&registry.failed).any(|live| {
                live.graph.lock().world == key.0 && live.graph.lock().id == key.1
                    && live.graph.lock().digest != proof.digest
            })
            || registry.generations.iter().any(|(id, generation)| {
                generation.world == key.0 && generation.binding().is_some_and(|binding| {
                    binding.lock == key.1
                        && (binding.digest != proof.digest || !proof.generations.contains(id)
                            || generation.ledger.snapshot().admission != crate::extensions::invocation::Admission::Closed)
                })
            })
        {
            return Err(LifecycleError::InvalidPersistedState);
        }
        registry.exact.remove(&key);
        registry.previous.retain(|live| live.graph.lock().world != key.0 || live.graph.lock().id != key.1);
        registry.failed.retain(|live| live.graph.lock().world != key.0 || live.graph.lock().id != key.1);
        registry.generations.retain(|_, generation| generation.world != key.0
            || generation.binding().is_none_or(|binding| binding.lock != key.1));
        Ok(())
    }

    pub fn retire_exact(
        &self,
        intent: &CommittedRetirement,
        graph: &BindingGraph,
    ) -> Result<RetiringGraph, LifecycleError> {
        self.gate
            .synchronized(|access| self.retire_exact_in(access, intent, graph))
    }

    /// Intent receipt is authoritative before any permanent live Closing occurs.
    /// Called in the same publication callback that clears the original reservation.
    pub fn retire_exact_in(
        &self,
        access: &GateAccess<'_>,
        intent: &CommittedRetirement,
        graph: &BindingGraph,
    ) -> Result<RetiringGraph, LifecycleError> {
        assert!(access.belongs_to(&self.gate));
        if intent.world() != &graph.lock().world
            || intent.lock() != &graph.lock().id
            || intent.digest() != &graph.lock().digest
        {
            return Err(LifecycleError::InvalidPersistedState);
        }
        let mut registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        // No require_lock_open here: the original intent still owns its pending scope.
        let graphs = retirement_graphs(&registry, graph)?;
        let generations = registry
            .generations
            .iter()
            .filter(|(_, generation)| {
                generation.world == graph.lock().world
                    && generation.binding().is_some_and(|binding| binding.lock == graph.lock().id)
            })
            .map(|(id, generation)| (id.clone(), generation.ledger.clone()))
            .collect::<Vec<_>>();
        registry
            .retired
            .insert((graph.lock().world.clone(), graph.lock().id.clone()));
        for (_, ledger) in &generations {
            ledger.close_admission();
        }
        Ok(RetiringGraph {
            origin: self.identity.clone(),
            world: graph.lock().world.clone(),
            lock: graph.lock().id.clone(),
            digest: graph.lock().digest.clone(),
            graphs,
            generations,
        })
    }
}

fn retirement_graphs(
    registry: &Registry,
    graph: &BindingGraph,
) -> Result<Vec<Arc<LiveGraph>>, LifecycleError> {
    let matches = |live: &&Arc<LiveGraph>| {
        live.graph.lock().world == graph.lock().world && live.graph.lock().id == graph.lock().id
    };
    // A candidate can own a publication; reject it before committing retirement intent.
    if registry.candidates.iter().any(|live| {
        live.graph.lock().world == graph.lock().world && live.graph.lock().id == graph.lock().id
    }) {
        return Err(LifecycleError::AlreadyPrepared);
    }
    let graphs = registry
        .exact
        .values()
        .chain(&registry.previous)
        .chain(&registry.failed)
        .filter(matches)
        .cloned()
        .collect::<Vec<_>>();
    if graphs
        .iter()
        .any(|live| live.graph.lock().digest != graph.lock().digest)
        || registry.generations.values().any(|generation| {
            generation.world == graph.lock().world
                && generation.binding().is_some_and(|binding| {
                    binding.lock == graph.lock().id && binding.digest != graph.lock().digest
                })
        })
    {
        return Err(LifecycleError::InvalidPersistedState);
    }
    Ok(graphs)
}

impl RetiringGraph {
    pub(crate) fn lock(&self) -> &ActivationLockId {
        &self.lock
    }

    /// Timeout returns this same custody capability and the exact remaining ledgers.
    pub async fn drain_until(
        self,
        deadline: Instant,
    ) -> Result<DrainedGraph, (Self, Vec<LedgerSnapshot>)> {
        for (_, ledger) in &self.generations {
            let _ = ledger.request_cancel();
        }
        let mut remaining = futures_util::future::join_all(
            self.graphs.iter().map(|graph| drain_graph(graph, deadline)),
        )
        .await
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        for (_, ledger) in &self.generations {
            if !matches!(
                ledger.drain_until(deadline).await,
                Ok(DrainOutcome::Drained)
            ) {
                let snapshot = ledger.snapshot();
                if !remaining
                    .iter()
                    .any(|current| current.generation == snapshot.generation)
                {
                    remaining.push(snapshot);
                }
            }
        }
        if !remaining.is_empty() {
            return Err((self, remaining));
        }
        Ok(DrainedGraph {
            origin: self.origin.clone(),
            world: self.world.clone(),
            lock: self.lock.clone(),
            digest: self.digest.clone(),
            generations: self.generations.iter().map(|(id, _)| id.clone()).collect(),
            process_failures: self
                .graphs
                .iter()
                .flat_map(|graph| graph.process_failures(None))
                .collect(),
        })
    }
}
