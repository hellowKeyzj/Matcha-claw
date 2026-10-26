use std::sync::Arc;

use tokio::time::Instant;
use world_protocol::{
    bindings::BindingChannel,
    ids::{CommitId, Generation, WorldRef},
};

use super::{
    LifecycleError, LiveExtensions, PreparedGraph,
    live::{LiveGraph, Registry, drain_graph},
};
use crate::{
    extensions::{
        bindings::{BindingGraph, GateAccess, PreparedRestore},
        invocation::{Admission, DrainOutcome, LedgerSnapshot, ResourceLedger},
        process::ProcessError,
    },
    store::{CommittedWorldMutation, CommittedWorldRestore, WorldRestoreIntent},
};

pub(super) struct WorldMutationFence {
    incarnation: Generation,
    commit: CommitId,
    final_commit: CommitId,
    applied: bool,
    recovery: Option<Arc<RestoreRecovery>>,
}

impl WorldMutationFence {
    pub(super) fn accepts_checkpoint(&self, intent: &CommittedWorldMutation) -> bool {
        self.recovery.is_none()
            && self.matches(
                &intent.operation().incarnation,
                intent.commit_id(),
                intent.final_commit_id(),
            )
    }

    fn matches(
        &self,
        incarnation: &Generation,
        commit: &CommitId,
        final_commit: &CommitId,
    ) -> bool {
        !self.applied
            && &self.incarnation == incarnation
            && &self.commit == commit
            && &self.final_commit == final_commit
    }
}

/// Minted only while this owner has never held resources for the restored world.
#[must_use]
pub(crate) struct RestoreRecovery {
    origin: Arc<()>,
    world: WorldRef,
    incarnation: Generation,
    commit: CommitId,
    final_commit: CommitId,
}

impl RestoreRecovery {
    pub fn world(&self) -> &WorldRef {
        &self.world
    }
    pub fn commit_id(&self) -> &CommitId {
        &self.commit
    }
}

#[must_use = "checkpoint accepted work and retain custody until world mutation really drains"]
pub(crate) struct WorldClosing {
    origin: Arc<()>,
    world: WorldRef,
    incarnation: Generation,
    commit: CommitId,
    final_commit: CommitId,
    graphs: Vec<Arc<LiveGraph>>,
    restore_graphs: Vec<(Arc<BindingGraph>, Vec<BindingChannel>)>,
    generations: Vec<ResourceLedger>,
}

#[must_use = "settle only the original durable world mutation intent"]
pub(crate) struct DrainedWorld {
    origin: Arc<()>,
    world: WorldRef,
    incarnation: Generation,
    commit: CommitId,
    final_commit: CommitId,
    restore_graphs: Vec<(Arc<BindingGraph>, Vec<BindingChannel>)>,
    process_failures: Vec<Arc<ProcessError>>,
}

enum RestorePublication<'a> {
    Drained(&'a DrainedWorld),
    Recovery(&'a RestoreRecovery),
}

fn check_restore_identity(
    intent: &CommittedWorldMutation,
    committed: &CommittedWorldRestore,
) -> Result<(), LifecycleError> {
    if intent.restore().is_none()
        || intent.world() != committed.world()
        || intent.commit_id() != committed.intent_commit_id()
        || intent.final_commit_id() != committed.commit_id()
    {
        return Err(LifecycleError::InvalidPersistedState);
    }
    Ok(())
}

impl DrainedWorld {
    pub fn world(&self) -> &WorldRef {
        &self.world
    }
    pub fn commit_id(&self) -> &CommitId {
        &self.commit
    }
    pub fn process_failures(&self) -> &[Arc<ProcessError>] {
        &self.process_failures
    }
    pub fn affected_graphs(&self) -> Vec<(Arc<BindingGraph>, Vec<BindingChannel>)> {
        self.restore_graphs.clone()
    }
}

impl LiveExtensions {
    pub fn world_restore_applied(
        &self,
        intent: &CommittedWorldMutation,
        committed: &CommittedWorldRestore,
    ) -> Result<bool, LifecycleError> {
        check_restore_identity(intent, committed)?;
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            if registry.stopped_worlds.contains(intent.world()) {
                return Err(LifecycleError::Retiring);
            }
            let Some(fence) = registry.world_mutations.get(intent.world()) else {
                return Ok(false);
            };
            if fence.incarnation != intent.operation().incarnation
                || &fence.commit != intent.commit_id()
                || &fence.final_commit != committed.commit_id()
            {
                return Err(LifecycleError::InvalidPersistedState);
            }
            Ok(fence.applied && !registry.closing_worlds.contains(intent.world()))
        })
    }

    pub fn begin_restore_recovery(
        &self,
        intent: &CommittedWorldMutation,
        committed: &CommittedWorldRestore,
    ) -> Result<Option<Arc<RestoreRecovery>>, LifecycleError> {
        check_restore_identity(intent, committed)?;
        self.gate.synchronized(|_| {
            let mut registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            let world = intent.world();
            if registry.stopped_worlds.contains(world) {
                return Err(LifecycleError::Retiring);
            }
            if let Some(fence) = registry.world_mutations.get(world) {
                if fence.incarnation != intent.operation().incarnation
                    || &fence.commit != intent.commit_id()
                    || &fence.final_commit != committed.commit_id()
                {
                    return Err(LifecycleError::InvalidPersistedState);
                }
                if fence.applied && !registry.closing_worlds.contains(world) {
                    return Ok(None);
                }
                return fence
                    .recovery
                    .clone()
                    .map(Some)
                    .ok_or(LifecycleError::Retiring);
            }
            if registry.closing_worlds.contains(world)
                || registry
                    .generations
                    .values()
                    .any(|generation| &generation.world == world)
                || registry
                    .candidates
                    .iter()
                    .chain(&registry.failed)
                    .chain(&registry.previous)
                    .chain(registry.exact.values())
                    .any(|graph| &graph.graph.lock().world == world)
            {
                return Err(LifecycleError::Retiring);
            }
            let proof = Arc::new(RestoreRecovery {
                origin: self.identity.clone(),
                world: world.clone(),
                incarnation: intent.operation().incarnation.clone(),
                commit: intent.commit_id().clone(),
                final_commit: committed.commit_id().clone(),
            });
            registry.world_mutations.insert(
                world.clone(),
                WorldMutationFence {
                    incarnation: proof.incarnation.clone(),
                    commit: proof.commit.clone(),
                    final_commit: proof.final_commit.clone(),
                    applied: false,
                    recovery: Some(proof.clone()),
                },
            );
            registry.closing_worlds.insert(world.clone());
            Ok(Some(proof))
        })
    }

    pub(super) fn require_restore_recovery(
        &self,
        registry: &Registry,
        proof: &RestoreRecovery,
    ) -> Result<(), LifecycleError> {
        if !Arc::ptr_eq(&self.identity, &proof.origin)
            || !registry.closing_worlds.contains(&proof.world)
            || registry.stopped_worlds.contains(&proof.world)
            || registry.transfer_closing(&proof.world)
            || registry
                .world_mutations
                .get(&proof.world)
                .is_none_or(|fence| {
                    !fence.matches(&proof.incarnation, &proof.commit, &proof.final_commit)
                        || fence
                            .recovery
                            .as_ref()
                            .is_none_or(|held| !std::ptr::eq(held.as_ref(), proof))
                })
            || registry.generations.values().any(|generation| {
                generation.world == proof.world
                    && generation.binding().is_none_or(|binding| {
                        binding.restore_commit.as_ref() != Some(&proof.commit)
                    })
            })
        {
            return Err(LifecycleError::Retiring);
        }
        Ok(())
    }

    pub fn validate_restore_recovery(&self, proof: &RestoreRecovery) -> bool {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            self.require_restore_recovery(&registry, proof).is_ok()
        })
    }

    pub fn close_world(
        &self,
        intent: &CommittedWorldMutation,
    ) -> Result<WorldClosing, LifecycleError> {
        self.gate.synchronized(|_| {
            let mut registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            let incarnation = &intent.operation().incarnation;
            if registry.stopped_worlds.contains(intent.world())
                || registry.transfer_closing(intent.world())
                || registry
                    .world_mutations
                    .get(intent.world())
                    .is_some_and(|fence| {
                        (!fence.applied && fence.recovery.is_some())
                            || fence.incarnation.0 > incarnation.0
                            || (fence.incarnation == *incarnation
                                && !fence.matches(
                                    incarnation,
                                    intent.commit_id(),
                                    intent.final_commit_id(),
                                ))
                            || (fence.incarnation.0 < incarnation.0 && !fence.applied)
                    })
            {
                return Err(LifecycleError::Retiring);
            }
            registry.world_mutations.insert(
                intent.world().clone(),
                WorldMutationFence {
                    incarnation: incarnation.clone(),
                    commit: intent.commit_id().clone(),
                    final_commit: intent.final_commit_id().clone(),
                    applied: false,
                    recovery: None,
                },
            );
            registry.close_world(intent.world(), false);
            let graphs = registry
                .candidates
                .iter()
                .chain(&registry.failed)
                .chain(&registry.previous)
                .chain(registry.exact.values())
                .filter(|graph| &graph.graph.lock().world == intent.world())
                .cloned()
                .collect();
            let restore_graphs = registry
                .exact
                .values()
                .filter(|graph| {
                    &graph.graph.lock().world == intent.world()
                        && !registry
                            .retired
                            .contains(&(intent.world().clone(), graph.graph.lock().id.clone()))
                })
                .map(|graph| (graph.graph.clone(), graph.channels.clone()))
                .collect();
            let generations = registry
                .generations
                .values()
                .filter(|generation| &generation.world == intent.world())
                .map(|generation| generation.ledger.clone())
                .collect();
            Ok(WorldClosing {
                origin: self.identity.clone(),
                world: intent.world().clone(),
                incarnation: incarnation.clone(),
                commit: intent.commit_id().clone(),
                final_commit: intent.final_commit_id().clone(),
                graphs,
                restore_graphs,
                generations,
            })
        })
    }

    pub(super) fn require_world_restore(
        &self,
        registry: &Registry,
        intent: &WorldRestoreIntent<'_>,
        proof: &DrainedWorld,
    ) -> Result<(), LifecycleError> {
        if !Arc::ptr_eq(&self.identity, &proof.origin)
            || intent.world() != &proof.world
            || intent.commit_id() != &proof.commit
            || intent.final_commit_id() != &proof.final_commit
            || !registry.closing_worlds.contains(&proof.world)
            || registry.stopped_worlds.contains(&proof.world)
            || registry.transfer_closing(&proof.world)
            || registry
                .world_mutations
                .get(&proof.world)
                .is_none_or(|fence| {
                    !fence.matches(&proof.incarnation, &proof.commit, &proof.final_commit)
                })
            || registry.generations.values().any(|generation| {
                generation.world == proof.world
                    && generation.binding().is_none_or(|binding| {
                        binding.restore_commit.as_ref() != Some(&proof.commit)
                    })
                    && generation.ledger.snapshot().admission != Admission::Closed
            })
        {
            return Err(LifecycleError::Retiring);
        }
        Ok(())
    }

    pub fn publish_world_restore(
        &self,
        access: &GateAccess<'_>,
        committed: &CommittedWorldRestore,
        proof: &DrainedWorld,
        graphs: &mut Vec<PreparedGraph>,
        selection: &PreparedRestore,
    ) -> Result<(), LifecycleError> {
        self.publish_restore_in(
            access,
            committed,
            RestorePublication::Drained(proof),
            graphs,
            selection,
        )
    }

    pub fn publish_world_restore_recovery(
        &self,
        access: &GateAccess<'_>,
        committed: &CommittedWorldRestore,
        proof: &RestoreRecovery,
        graphs: &mut Vec<PreparedGraph>,
        selection: &PreparedRestore,
    ) -> Result<(), LifecycleError> {
        self.publish_restore_in(
            access,
            committed,
            RestorePublication::Recovery(proof),
            graphs,
            selection,
        )
    }

    fn publish_restore_in(
        &self,
        access: &GateAccess<'_>,
        committed: &CommittedWorldRestore,
        publication: RestorePublication<'_>,
        graphs: &mut Vec<PreparedGraph>,
        selection: &PreparedRestore,
    ) -> Result<(), LifecycleError> {
        assert!(access.belongs_to(&self.gate));
        let mut registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        let (origin, world, incarnation, commit, final_commit) = match publication {
            RestorePublication::Drained(proof) => (
                &proof.origin,
                &proof.world,
                &proof.incarnation,
                &proof.commit,
                &proof.final_commit,
            ),
            RestorePublication::Recovery(proof) => {
                self.require_restore_recovery(&registry, proof)?;
                (
                    &proof.origin,
                    &proof.world,
                    &proof.incarnation,
                    &proof.commit,
                    &proof.final_commit,
                )
            }
        };
        if !Arc::ptr_eq(&self.identity, origin)
            || committed.world() != world
            || committed.intent_commit_id() != commit
            || committed.commit_id() != final_commit
            || selection.world() != world
            || selection.commit_id() != final_commit
            || !registry.closing_worlds.contains(world)
            || registry.stopped_worlds.contains(world)
            || registry
                .world_mutations
                .get(world)
                .is_none_or(|fence| !fence.matches(incarnation, commit, final_commit))
        {
            return Err(LifecycleError::Retiring);
        }
        let mut selected = std::collections::BTreeSet::new();
        let mut selected_generations = std::collections::BTreeSet::new();
        for prepared in graphs.iter() {
            let graph = prepared.graph();
            if &graph.lock().world != world
                || !selected.insert(graph.lock().id.clone())
                || registry
                    .retired
                    .contains(&(world.clone(), graph.lock().id.clone()))
                || !registry
                    .candidates
                    .iter()
                    .any(|candidate| Arc::ptr_eq(candidate, &prepared.inner))
            {
                return Err(LifecycleError::InvalidPersistedState);
            }
            access
                .require_lock_open(world, &graph.lock().id)
                .map_err(LifecycleError::Gate)?;
            let heads = prepared
                .channels()
                .iter()
                .map(|channel| channel.channel.clone())
                .collect::<Vec<_>>();
            let domains = graph
                .lock()
                .nodes
                .iter()
                .filter_map(|node| node.state.as_ref().map(|state| state.writer_domain.clone()))
                .collect::<Vec<_>>();
            access
                .require_open(world, &heads, &domains)
                .map_err(LifecycleError::Gate)?;
            for node in prepared.inner.nodes.values() {
                let snapshot = node.ledger.snapshot();
                let generation = registry
                    .generations
                    .get(&snapshot.generation)
                    .ok_or(LifecycleError::InvalidPersistedState)?;
                if snapshot.admission != Admission::Open
                    || !selected_generations.insert(snapshot.generation)
                    || generation.binding().is_none_or(|binding| {
                        binding.restore_commit.as_ref() != Some(commit)
                    })
                    || !generation.ledger.same_instance(&node.ledger)
                    || registry
                        .install_fences
                        .get(&(world.clone(), generation.install.clone()))
                        .is_some_and(|fence| fence.closing)
                {
                    return Err(LifecycleError::Retiring);
                }
            }
        }
        if registry.generations.iter().any(|(id, generation)| {
            &generation.world == world
                && !selected_generations.contains(id)
                && generation.ledger.snapshot().admission != Admission::Closed
        }) {
            return Err(LifecycleError::Retiring);
        }
        if selection.required_graphs().any(|required| {
            !graphs
                .iter()
                .any(|fresh| fresh.graph().lock() == required.lock())
        }) {
            return Err(LifecycleError::InvalidPersistedState);
        }
        for prepared in graphs.drain(..) {
            registry
                .candidates
                .retain(|candidate| !Arc::ptr_eq(candidate, &prepared.inner));
            let key = (world.clone(), prepared.graph().lock().id.clone());
            if let Some(previous) = registry.exact.insert(key, prepared.inner) {
                registry.previous.push(previous);
            }
        }
        let fence = registry
            .world_mutations
            .get_mut(world)
            .expect("validated world mutation fence");
        fence.applied = true;
        fence.recovery = None;
        registry.closing_worlds.remove(world);
        Ok(())
    }

    pub fn accepted_world_closing(
        &self,
        intent: &CommittedWorldMutation,
        proof: &WorldClosing,
    ) -> Result<super::AcceptedClosing, LifecycleError> {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            if !self.world_closing_matches(&registry, intent, proof) {
                return Err(LifecycleError::Retiring);
            }
            Ok(super::AcceptedClosing::world_selection(
                self.identity.clone(),
                intent,
            ))
        })
    }

    pub fn validate_world_closing(
        &self,
        intent: &CommittedWorldMutation,
        proof: &WorldClosing,
    ) -> bool {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            self.world_closing_matches(&registry, intent, proof)
        })
    }

    fn world_closing_matches(
        &self,
        registry: &Registry,
        intent: &CommittedWorldMutation,
        proof: &WorldClosing,
    ) -> bool {
        Arc::ptr_eq(&self.identity, &proof.origin)
            && intent.world() == &proof.world
            && intent.operation().incarnation == proof.incarnation
            && intent.commit_id() == &proof.commit
            && intent.final_commit_id() == &proof.final_commit
            && registry.closing_worlds.contains(&proof.world)
            && !registry.stopped_worlds.contains(&proof.world)
            && registry
                .world_mutations
                .get(&proof.world)
                .is_some_and(|fence| fence.accepts_checkpoint(intent))
    }

    pub fn validate_world_drained(&self, proof: &DrainedWorld) -> bool {
        if !Arc::ptr_eq(&self.identity, &proof.origin) {
            return false;
        }
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            registry.closing_worlds.contains(&proof.world)
                && !registry.stopped_worlds.contains(&proof.world)
                && registry
                    .world_mutations
                    .get(&proof.world)
                    .is_some_and(|fence| {
                        fence.matches(&proof.incarnation, &proof.commit, &proof.final_commit)
                    })
        })
    }
}

impl WorldClosing {
    pub fn world(&self) -> &WorldRef {
        &self.world
    }
    pub fn commit_id(&self) -> &CommitId {
        &self.commit
    }
    pub fn final_commit_id(&self) -> &CommitId {
        &self.final_commit
    }
    pub fn invocations(&self) -> std::collections::BTreeSet<world_protocol::ids::InvocationId> {
        self.generations
            .iter()
            .flat_map(|ledger| ledger.snapshot().resources)
            .filter_map(|resource| resource.spec.invocation)
            .collect()
    }

    pub async fn drain_until(
        self,
        deadline: Instant,
    ) -> Result<DrainedWorld, (Self, Vec<LedgerSnapshot>)> {
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
        Ok(DrainedWorld {
            origin: self.origin,
            world: self.world,
            incarnation: self.incarnation,
            commit: self.commit,
            final_commit: self.final_commit,
            restore_graphs: self.restore_graphs,
            process_failures: self
                .graphs
                .iter()
                .flat_map(|graph| graph.process_failures(None))
                .collect(),
        })
    }
}
