use std::{collections::BTreeSet, sync::Arc};

use tokio::time::Instant;
use world_protocol::{
    ids::{CommitId, NodeId, PluginGenerationId},
    state::StateEpoch,
};

use super::{LifecycleError, LiveExtensions, live::LiveGraph};
use crate::extensions::{
    bindings::{BindingGraph, GateAccess},
    invocation::{DrainOutcome, LedgerSnapshot, Registration, ResourceLedger},
};

#[must_use = "retain this barrier until old-epoch execution has actually drained"]
pub(crate) struct DrainingState {
    origin: Arc<()>,
    epoch: StateEpoch,
    commit: CommitId,
    graphs: Vec<(Arc<LiveGraph>, BTreeSet<NodeId>)>,
    restore_graphs: Vec<(
        Arc<BindingGraph>,
        Vec<world_protocol::bindings::BindingChannel>,
    )>,
    generations: Vec<(PluginGenerationId, ResourceLedger)>,
}

#[must_use = "consume with the state owner in the original migration transaction"]
pub(crate) struct DrainedState {
    origin: Arc<()>,
    epoch: StateEpoch,
    commit: CommitId,
    restore_graphs: Vec<(
        Arc<BindingGraph>,
        Vec<world_protocol::bindings::BindingChannel>,
    )>,
    generations: Vec<PluginGenerationId>,
    process_failures: Vec<Arc<crate::extensions::process::ProcessError>>,
}

impl DrainedState {
    pub fn epoch(&self) -> &StateEpoch {
        &self.epoch
    }
    pub fn commit_id(&self) -> &CommitId {
        &self.commit
    }
    pub fn generations(&self) -> &[PluginGenerationId] {
        &self.generations
    }
    pub fn process_failures(&self) -> &[Arc<crate::extensions::process::ProcessError>] {
        &self.process_failures
    }
    pub fn affected_graphs(
        &self,
    ) -> Vec<(
        Arc<BindingGraph>,
        Vec<world_protocol::bindings::BindingChannel>,
    )> {
        self.restore_graphs.clone()
    }
}

impl LiveExtensions {
    /// The binding owner has already reserved the old writer domain under this
    /// original migration identity. No durable lock is permanently retired here.
    pub fn close_state_in(
        &self,
        access: &GateAccess<'_>,
        epoch: &StateEpoch,
        commit: &CommitId,
    ) -> Result<DrainingState, LifecycleError> {
        assert!(access.belongs_to(&self.gate));
        access
            .require_reserved(
                &epoch.world,
                commit,
                &[],
                std::slice::from_ref(&epoch.writer_domain),
            )
            .map_err(LifecycleError::Gate)?;
        let registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        let mut selected = registry
            .generations
            .iter()
            .filter(|(_, generation)| {
                generation.world == epoch.world
                    && generation.binding().is_some_and(|binding| {
                        binding.state.as_ref().is_some_and(|state| {
                            state.writer_domain == epoch.writer_domain
                                && state.writer_epoch == epoch.writer_epoch
                        })
                    })
            })
            .map(|(id, _)| id.clone())
            .collect::<BTreeSet<_>>();
        registry.include_consumers(&mut selected);
        let mut graphs = Vec::new();
        for graph in registry
            .candidates
            .iter()
            .chain(&registry.failed)
            .chain(&registry.previous)
            .chain(registry.exact.values())
            .filter(|graph| graph.graph.lock().world == epoch.world)
        {
            let nodes = graph
                .nodes
                .iter()
                .filter(|(_, node)| selected.contains(&node.ledger.snapshot().generation))
                .map(|(id, _)| id.clone())
                .collect::<BTreeSet<_>>();
            if nodes.is_empty() {
                continue;
            }
            graphs.push((graph.clone(), nodes));
        }
        let mut restored = BTreeSet::new();
        let restore_graphs = registry
            .exact
            .values()
            .chain(&registry.previous)
            .filter(|graph| {
                graph.graph.lock().world == epoch.world
                    && graph
                        .nodes
                        .values()
                        .any(|node| selected.contains(&node.ledger.snapshot().generation))
            })
            .filter(|graph| {
                restored.insert((
                    graph.graph.lock().id.clone(),
                    graph.graph.lock().digest.clone(),
                ))
            })
            .map(|graph| (graph.graph.clone(), graph.channels.clone()))
            .collect();
        let generations = selected
            .into_iter()
            .map(|id| {
                let ledger = registry.generations[&id].ledger.clone();
                ledger.close_admission();
                (id, ledger)
            })
            .collect();
        Ok(DrainingState {
            origin: self.identity.clone(),
            epoch: epoch.clone(),
            commit: commit.clone(),
            graphs,
            restore_graphs,
            generations,
        })
    }

    pub fn validate_state_drained(&self, proof: &DrainedState) -> bool {
        self.gate
            .synchronized(|access| self.validate_state_drained_in(access, proof))
    }

    pub fn validate_state_drained_in(&self, access: &GateAccess<'_>, proof: &DrainedState) -> bool {
        assert!(access.belongs_to(&self.gate));
        if !Arc::ptr_eq(&self.identity, &proof.origin) {
            return false;
        }
        let registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        !registry.closing_worlds.contains(&proof.epoch.world)
            && proof.generations.iter().all(|id| {
                registry.generations.get(id).is_some_and(|generation| {
                    generation.ledger.snapshot().admission
                        == crate::extensions::invocation::Admission::Closed
                })
            })
            && registry
                .generations
                .values()
                .filter(|generation| {
                    generation.world == proof.epoch.world
                        && generation.binding().is_some_and(|binding| {
                            binding.migration_commit.as_ref() == Some(&proof.commit)
                        })
                })
                .all(|generation| {
                    generation.ledger.snapshot().admission
                        == crate::extensions::invocation::Admission::Closed
                })
    }

    pub async fn drain_migration_tasks(
        &self,
        proof: &DrainedState,
        deadline: Instant,
    ) -> Result<Vec<LedgerSnapshot>, LifecycleError> {
        if !Arc::ptr_eq(&self.identity, &proof.origin) {
            return Err(LifecycleError::InvalidPersistedState);
        }
        let generations = self.gate.synchronized(|access| {
            access
                .require_reserved(
                    &proof.epoch.world,
                    &proof.commit,
                    &[],
                    std::slice::from_ref(&proof.epoch.writer_domain),
                )
                .map_err(LifecycleError::Gate)?;
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            let generations = registry
                .generations
                .values()
                .filter(|generation| {
                    generation.world == proof.epoch.world
                        && generation.binding().is_some_and(|binding| {
                            binding.migration_commit.as_ref() == Some(&proof.commit)
                        })
                })
                .map(|generation| generation.ledger.clone())
                .collect::<Vec<_>>();
            for ledger in &generations {
                ledger.close_admission();
            }
            Ok::<_, LifecycleError>(generations)
        })?;
        for ledger in &generations {
            let _ = ledger.request_cancel();
        }
        let mut remaining = Vec::new();
        for ledger in generations {
            if !matches!(
                ledger.drain_until(deadline).await,
                Ok(DrainOutcome::Drained)
            ) {
                remaining.push(ledger.snapshot());
            }
        }
        Ok(remaining)
    }

    pub fn new_migration_generation_in(
        &self,
        access: &GateAccess<'_>,
        expected: &StateEpoch,
        commit: &CommitId,
        source: &crate::extensions::bindings::BindingGraph,
        node: &NodeId,
        target: &world_protocol::bindings::ImplementationRef,
        limits: &world_protocol::package::PackageLimits,
    ) -> Result<(ResourceLedger, tokio::sync::OwnedSemaphorePermit), LifecycleError> {
        assert!(access.belongs_to(&self.gate));
        if source.lock().world != expected.world {
            return Err(LifecycleError::InvalidPersistedState);
        }
        access
            .require_reserved(
                &expected.world,
                commit,
                &[],
                std::slice::from_ref(&expected.writer_domain),
            )
            .map_err(LifecycleError::Gate)?;
        access
            .require_lock_open(&expected.world, &source.lock().id)
            .map_err(LifecycleError::Gate)?;
        let binding = source
            .node(node)
            .map_err(|_| LifecycleError::EndpointMismatch(node.clone()))?;
        if binding.state.as_ref().is_none_or(|state| {
            state.namespace != expected.namespace
                || state.writer_domain != expected.writer_domain
                || state.writer_epoch != expected.writer_epoch
                || state.schema != expected.schema
                || state.root.world != expected.world
                || state.root.id != expected.root.id
        }) {
            return Err(LifecycleError::EndpointMismatch(node.clone()));
        }
        let mut registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        if registry.closing_worlds.contains(&expected.world)
            || registry
                .retired
                .contains(&(expected.world.clone(), source.lock().id.clone()))
            || registry
                .install_fences
                .get(&(
                    expected.world.clone(),
                    binding.implementation.install_id.clone(),
                ))
                .is_some_and(|fence| fence.closing)
            || registry
                .install_fences
                .get(&(expected.world.clone(), target.install_id.clone()))
                .is_some_and(|fence| fence.closing)
        {
            return Err(LifecycleError::Retiring);
        }
        let permit = registry
            .calls_for(&expected.world, target, limits)?
            .try_acquire_owned()
            .map_err(|_| {
                LifecycleError::Contract(
                    world_protocol::lifecycle::LifecycleFailure::ConcurrentCallLimit {
                        node_id: node.clone(),
                    },
                )
            })?;
        let id =
            PluginGenerationId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID generation");
        let ledger = ResourceLedger::new(id.clone());
        registry.generations.insert(
            id,
            super::live::Generation {
                world: expected.world.clone(),
                install: target.install_id.clone(),
                kind: super::live::GenerationKind::Binding(super::live::BindingGeneration {
                    lock: source.lock().id.clone(),
                    digest: source.lock().digest.clone(),
                    node: node.clone(),
                    providers: Vec::new(),
                    restore_commit: None,
                    transfer: None,
                    migration_commit: Some(commit.clone()),
                    state: None,
                }),
                ledger: ledger.clone(),
            },
        );
        Ok((ledger, permit))
    }
}

impl DrainingState {
    pub fn affected_graphs(
        &self,
    ) -> Vec<(
        Arc<BindingGraph>,
        Vec<world_protocol::bindings::BindingChannel>,
    )> {
        self.restore_graphs.clone()
    }

    pub async fn drain_until(
        self,
        deadline: Instant,
    ) -> Result<DrainedState, (Self, Vec<LedgerSnapshot>)> {
        for (_, ledger) in &self.generations {
            let _ = ledger.request_cancel();
        }
        let mut remaining = Vec::new();
        for (graph, nodes) in &self.graphs {
            for id in graph
                .graph
                .prepare_order()
                .iter()
                .rev()
                .filter(|id| nodes.contains(*id))
            {
                let ledger = &graph.nodes[id].ledger;
                if matches!(
                    ledger.drain_until(deadline).await,
                    Ok(DrainOutcome::Drained)
                ) {
                    let dependencies: Option<Vec<Registration>> = graph
                        .dependencies
                        .lock()
                        .expect("world dependency custody poisoned")
                        .remove(id);
                    if let Some(dependencies) = dependencies {
                        for dependency in dependencies {
                            dependency.finish();
                        }
                    }
                }
            }
        }
        for (_, ledger) in &self.generations {
            if !matches!(
                ledger.drain_until(deadline).await,
                Ok(DrainOutcome::Drained)
            ) {
                remaining.push(ledger.snapshot());
            }
        }
        if !remaining.is_empty() {
            return Err((self, remaining));
        }
        Ok(DrainedState {
            origin: self.origin.clone(),
            epoch: self.epoch.clone(),
            commit: self.commit.clone(),
            restore_graphs: self.restore_graphs,
            generations: self.generations.iter().map(|(id, _)| id.clone()).collect(),
            process_failures: self
                .graphs
                .iter()
                .flat_map(|(graph, nodes)| graph.process_failures(Some(nodes)))
                .collect(),
        })
    }
}
