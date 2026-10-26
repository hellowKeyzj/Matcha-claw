use std::{collections::BTreeSet, sync::Arc};

use tokio::time::Instant;
use world_protocol::ids::{CommitId, InstallId, NodeId, PluginGenerationId, Revision, WorldRef};

use super::{LifecycleError, LiveExtensions, live::LiveGraph};
use crate::extensions::{
    invocation::{DrainOutcome, LedgerSnapshot, ResourceLedger},
    package::{CommittedDisable, CommittedEnable},
    process::ProcessError,
};

pub(super) struct InstallFence {
    pub(super) revision: Revision,
    pub(super) commit: CommitId,
    pub(super) closing: bool,
}

#[must_use = "retain closing custody until the install and its consumers really drain"]
pub(crate) struct ClosingInstall {
    origin: Arc<()>,
    world: WorldRef,
    install: InstallId,
    commit: CommitId,
    revision: Revision,
    graphs: Vec<(Arc<LiveGraph>, BTreeSet<NodeId>)>,
    generations: Vec<(PluginGenerationId, ResourceLedger)>,
}

#[must_use = "settle the original disable intent with its durable package owner"]
pub(crate) struct DrainedInstall {
    origin: Arc<()>,
    world: WorldRef,
    install: InstallId,
    commit: CommitId,
    revision: Revision,
    process_failures: Vec<Arc<ProcessError>>,
}

impl DrainedInstall {
    pub fn world(&self) -> &WorldRef {
        &self.world
    }
    pub fn install(&self) -> &InstallId {
        &self.install
    }
    pub fn commit_id(&self) -> &CommitId {
        &self.commit
    }
    pub fn revision(&self) -> Revision {
        self.revision
    }
    pub fn process_failures(&self) -> &[Arc<ProcessError>] {
        &self.process_failures
    }
}

impl LiveExtensions {
    pub fn close_install(
        &self,
        intent: &CommittedDisable,
    ) -> Result<ClosingInstall, LifecycleError> {
        self.gate.synchronized(|_| {
            let mut registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            let key = (intent.world().clone(), intent.install().clone());
            if let Some(fence) = registry.install_fences.get(&key) {
                if fence.revision > intent.revision() {
                    return Err(LifecycleError::Retiring);
                }
                if fence.revision == intent.revision()
                    && (!fence.closing || &fence.commit != intent.commit_id())
                {
                    return Err(LifecycleError::InvalidPersistedState);
                }
            }
            registry.install_fences.insert(
                key,
                InstallFence {
                    revision: intent.revision(),
                    commit: intent.commit_id().clone(),
                    closing: true,
                },
            );
            let mut selected = registry
                .generations
                .iter()
                .filter(|(_, generation)| {
                    &generation.world == intent.world() && &generation.install == intent.install()
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
                .filter(|graph| &graph.graph.lock().world == intent.world())
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
            let generations = selected
                .into_iter()
                .map(|id| {
                    let ledger = registry.generations[&id].ledger.clone();
                    ledger.close_admission();
                    (id, ledger)
                })
                .collect();
            Ok(ClosingInstall {
                origin: self.identity.clone(),
                world: intent.world().clone(),
                install: intent.install().clone(),
                commit: intent.commit_id().clone(),
                revision: intent.revision(),
                graphs,
                generations,
            })
        })
    }

    /// A committed enable admits only new generations; cancelled ledgers never reopen.
    pub fn enable_install(&self, intent: &CommittedEnable) -> Result<(), LifecycleError> {
        self.gate.synchronized(|_| {
            let mut registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            if registry.closing_worlds.contains(intent.world()) {
                return Err(LifecycleError::Retiring);
            }
            let key = (intent.world().clone(), intent.install().clone());
            if let Some(fence) = registry.install_fences.get(&key) {
                if fence.revision > intent.revision() {
                    return Err(LifecycleError::Retiring);
                }
                if fence.revision == intent.revision()
                    && (fence.closing || &fence.commit != intent.commit_id())
                {
                    return Err(LifecycleError::InvalidPersistedState);
                }
            }
            registry.install_fences.insert(
                key,
                InstallFence {
                    revision: intent.revision(),
                    commit: intent.commit_id().clone(),
                    closing: false,
                },
            );
            Ok(())
        })
    }

    pub fn accepted_install_closing(
        &self,
        intent: &CommittedDisable,
        proof: &ClosingInstall,
    ) -> Result<super::AcceptedClosing, LifecycleError> {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            if !self.install_closing_matches(&registry, intent, proof) {
                return Err(LifecycleError::Retiring);
            }
            Ok(super::AcceptedClosing::install_selection(
                self.identity.clone(),
                intent,
            ))
        })
    }

    pub fn validate_install_closing(
        &self,
        intent: &CommittedDisable,
        proof: &ClosingInstall,
    ) -> bool {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            self.install_closing_matches(&registry, intent, proof)
        })
    }

    fn install_closing_matches(
        &self,
        registry: &super::live::Registry,
        intent: &CommittedDisable,
        proof: &ClosingInstall,
    ) -> bool {
        Arc::ptr_eq(&self.identity, &proof.origin)
            && intent.world() == &proof.world
            && intent.install() == &proof.install
            && intent.revision() == proof.revision
            && intent.commit_id() == &proof.commit
            && registry
                .install_fences
                .get(&(proof.world.clone(), proof.install.clone()))
                .is_some_and(|fence| {
                    fence.closing
                        && fence.revision == proof.revision
                        && fence.commit == proof.commit
                })
    }

    pub fn validate_install_drained(&self, proof: &DrainedInstall) -> bool {
        if !Arc::ptr_eq(&self.identity, &proof.origin) {
            return false;
        }
        self.gate.synchronized(|_| {
            self.registry
                .lock()
                .expect("world extension registry poisoned")
                .install_fences
                .get(&(proof.world.clone(), proof.install.clone()))
                .is_some_and(|fence| {
                    fence.closing
                        && fence.revision == proof.revision
                        && fence.commit == proof.commit
                })
        })
    }
}

impl ClosingInstall {
    pub fn invocations(&self) -> BTreeSet<world_protocol::ids::InvocationId> {
        self.generations
            .iter()
            .flat_map(|(_, ledger)| ledger.snapshot().resources)
            .filter_map(|resource| resource.spec.invocation)
            .collect()
    }

    /// Close admission first and durably checkpoint accepted work before calling this.
    pub async fn drain_until(
        self,
        deadline: Instant,
    ) -> Result<DrainedInstall, (Self, Vec<LedgerSnapshot>)> {
        for (_, ledger) in &self.generations {
            let _ = ledger.request_cancel();
        }
        for (graph, nodes) in &self.graphs {
            for id in graph
                .graph
                .prepare_order()
                .iter()
                .rev()
                .filter(|id| nodes.contains(*id))
            {
                if matches!(
                    graph.nodes[id].ledger.drain_until(deadline).await,
                    Ok(DrainOutcome::Drained)
                ) {
                    let dependencies = graph
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
        let mut remaining = Vec::new();
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
        let process_failures = self
            .graphs
            .iter()
            .flat_map(|(graph, nodes)| graph.process_failures(Some(nodes)))
            .collect();
        Ok(DrainedInstall {
            origin: self.origin,
            world: self.world,
            install: self.install,
            commit: self.commit,
            revision: self.revision,
            process_failures,
        })
    }
}
