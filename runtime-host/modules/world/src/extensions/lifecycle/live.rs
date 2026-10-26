use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, OnceLock},
};

use tokio::sync::Semaphore;

use tokio::time::Instant;
use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingChannel, ImplementationRef},
    ids::*,
    lifecycle::LifecycleFailure,
    package::PackageLimits,
    time::Timestamp,
};

use super::{LifecycleError, preparation::Preparation};
use crate::extensions::{
    bindings::{BindingGraph, GateAccess, PublicationGate},
    invocation::{
        DrainOutcome, InvocationLease, LeaseFailure, LedgerSnapshot, Registration, ResourceKind,
        ResourceLedger, ResourceSpec,
    },
    process::{PreparedProcess, ProcessClient},
    wasm::PreparedWasm,
};
use crate::{abstraction::PreparedAbstraction, actions::PreparedAction, agent_bridge::PreparedAgentBridge, authorization::PreparedPolicy, compiler::{PreparedCompiler, PreparedSchema}, context::PreparedContext, evaluation::PreparedEvaluation, facts::support::PreparedProvenance, identity::PreparedIdentity, query::{PreparedProjection, PreparedReconcile, PreparedResolver}, sources::connectors::PreparedSource, store::PreparedStorage};

pub(crate) enum Endpoint {
    Wasm(Arc<PreparedWasm>),
    Process(ProcessClient),
    Source(Arc<PreparedSource>),
    Identity(Arc<PreparedIdentity>),
    Schema(Arc<PreparedSchema>),
    Compiler(Arc<PreparedCompiler>),
    Policy(Arc<PreparedPolicy>),
    Provenance(Arc<PreparedProvenance>),
    Action(Arc<PreparedAction>),
    Evaluation(Arc<PreparedEvaluation>),
    Projection(Arc<PreparedProjection>),
    Reconcile(Arc<PreparedReconcile>),
    Abstraction(Arc<PreparedAbstraction>),
    AgentBridge(Arc<PreparedAgentBridge>),
    Storage(Arc<PreparedStorage>),
    Resolver(Arc<PreparedResolver>),
    Context(Arc<PreparedContext>),
}

impl Endpoint {
    pub(crate) fn limits(&self) -> &PackageLimits {
        match self {
            Self::Wasm(prepared) => prepared.limits(),
            Self::Process(client) => client.limits(),
            Self::Source(prepared) => prepared.limits(),
            Self::Identity(prepared) => prepared.limits(),
            Self::Schema(prepared) => prepared.limits(),
            Self::Compiler(prepared) => prepared.limits(),
            Self::Policy(prepared) => prepared.limits(),
            Self::Provenance(prepared) => prepared.limits(),
            Self::Action(prepared) => prepared.limits(),
            Self::Evaluation(prepared) => prepared.limits(),
            Self::Projection(prepared) => prepared.limits(),
            Self::Reconcile(prepared) => prepared.limits(),
            Self::Abstraction(prepared) => prepared.limits(),
            Self::AgentBridge(prepared) => prepared.limits(),
            Self::Storage(prepared) => prepared.limits(),
            Self::Resolver(prepared) => prepared.limits(),
            Self::Context(prepared) => prepared.limits(),
        }
    }
}

/// Constructed only from a real adapter's successful prepare/readiness result.
/// Runtime instances and child/task custody remain exclusively in their ledger.
pub(crate) struct PreparedNode {
    id: NodeId,
    implementation: ImplementationRef,
    config: PackageConfigView,
    endpoint: Arc<Endpoint>,
    pub(super) ledger: ResourceLedger,
    calls: OnceLock<Arc<Semaphore>>,
}

impl PreparedNode {
    pub fn wasm(id: NodeId, prepared: Arc<PreparedWasm>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Wasm(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn process(id: NodeId, prepared: PreparedProcess, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.client.implementation().clone(),
            config: prepared.client.config().clone(),
            endpoint: Arc::new(Endpoint::Process(prepared.client)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn identity(id: NodeId, prepared: Arc<PreparedIdentity>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Identity(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn schema(id: NodeId, prepared: Arc<PreparedSchema>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Schema(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn compiler(id: NodeId, prepared: Arc<PreparedCompiler>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Compiler(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn policy(id: NodeId, prepared: Arc<PreparedPolicy>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Policy(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn provenance(id: NodeId, prepared: Arc<PreparedProvenance>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Provenance(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn action(id: NodeId, prepared: Arc<PreparedAction>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Action(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn evaluation(id: NodeId, prepared: Arc<PreparedEvaluation>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Evaluation(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn projection(id: NodeId, prepared: Arc<PreparedProjection>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Projection(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn reconcile(id: NodeId, prepared: Arc<PreparedReconcile>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Reconcile(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn abstraction(id: NodeId, prepared: Arc<PreparedAbstraction>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Abstraction(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn agent_bridge(id: NodeId, prepared: Arc<PreparedAgentBridge>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::AgentBridge(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn storage(id: NodeId, prepared: Arc<PreparedStorage>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Storage(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn resolver(id: NodeId, prepared: Arc<PreparedResolver>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Resolver(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn context(id: NodeId, prepared: Arc<PreparedContext>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Context(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }

    pub fn source(id: NodeId, prepared: Arc<PreparedSource>, ledger: ResourceLedger) -> Self {
        Self {
            id,
            implementation: prepared.implementation().clone(),
            config: prepared.config().clone(),
            endpoint: Arc::new(Endpoint::Source(prepared)),
            ledger,
            calls: OnceLock::new(),
        }
    }
}

pub(super) struct LiveGraph {
    pub(super) graph: Arc<BindingGraph>,
    pub(super) channels: Vec<BindingChannel>,
    pub(super) configs: Vec<PackageConfigView>,
    pub(super) nodes: BTreeMap<NodeId, PreparedNode>,
    pub(super) dependencies: Mutex<BTreeMap<NodeId, Vec<Registration>>>,
    rejected_nodes: Vec<PreparedNode>,
}

impl LiveGraph {
    pub(super) fn process_failures(
        &self,
        nodes: Option<&BTreeSet<NodeId>>,
    ) -> Vec<Arc<crate::extensions::process::ProcessError>> {
        self.nodes
            .values()
            .chain(&self.rejected_nodes)
            .filter(|node| nodes.is_none_or(|nodes| nodes.contains(&node.id)))
            .filter_map(|node| match node.endpoint.as_ref() {
                Endpoint::Process(client) => client.failure(),
                _ => None,
            })
            .collect()
    }
}

/// A capability for one fully prepared candidate. LiveExtensions owns custody
/// even if its caller is cancelled or drops the publication reservation.
#[must_use = "publish the prepared graph or explicitly retire the candidate"]
pub(crate) struct PreparedGraph {
    pub(super) inner: Arc<LiveGraph>,
}

impl PreparedGraph {
    pub fn graph(&self) -> &Arc<BindingGraph> {
        &self.inner.graph
    }
    pub fn channels(&self) -> &[BindingChannel] {
        &self.inner.channels
    }
    pub fn configs(&self) -> &[PackageConfigView] {
        &self.inner.configs
    }
}

#[derive(Default)]
pub(super) struct Registry {
    pub(super) candidates: Vec<Arc<LiveGraph>>,
    pub(super) failed: Vec<Arc<LiveGraph>>,
    pub(super) exact: BTreeMap<(WorldRef, ActivationLockId), Arc<LiveGraph>>,
    pub(super) previous: Vec<Arc<LiveGraph>>,
    pools: BTreeMap<(WorldRef, InstallId, Digest), CallPool>,
    pub(super) retired: BTreeSet<(WorldRef, ActivationLockId)>,
    pub(super) closing_worlds: BTreeSet<WorldRef>,
    pub(super) stopped_worlds: BTreeSet<WorldRef>,
    pub(super) install_fences: BTreeMap<(WorldRef, InstallId), super::install::InstallFence>,
    pub(super) world_mutations: BTreeMap<WorldRef, super::world::WorldMutationFence>,
    pub(super) transfers: BTreeMap<WorldRef, super::transfer::TransferFence>,
    pub(super) generations: BTreeMap<PluginGenerationId, Generation>,
}

impl Registry {
    pub(super) fn calls_for(
        &mut self,
        world: &WorldRef,
        implementation: &ImplementationRef,
        limits: &PackageLimits,
    ) -> Result<Arc<Semaphore>, LifecycleError> {
        if limits.maximum_concurrent_calls == 0 {
            return Err(LifecycleError::InvalidPersistedState);
        }
        let key = (
            world.clone(),
            implementation.install_id.clone(),
            implementation.package_digest.clone(),
        );
        let pool = self.pools.entry(key).or_insert_with(|| CallPool {
            limits: limits.clone(),
            calls: Arc::new(Semaphore::new(limits.maximum_concurrent_calls as usize)),
        });
        if pool.limits != *limits {
            return Err(LifecycleError::InvalidPersistedState);
        }
        Ok(pool.calls.clone())
    }

    pub(super) fn close_world(&mut self, world: &WorldRef, quarantine: bool) {
        self.closing_worlds.insert(world.clone());
        for generation in self
            .generations
            .values()
            .filter(|generation| &generation.world == world)
        {
            if quarantine {
                generation.ledger.quarantine();
            } else {
                generation.ledger.close_admission();
            }
        }
        for graph in self
            .candidates
            .iter()
            .chain(&self.failed)
            .chain(&self.previous)
            .chain(self.exact.values())
            .filter(|graph| &graph.graph.lock().world == world)
        {
            for node in graph.nodes.values().chain(&graph.rejected_nodes) {
                if quarantine {
                    node.ledger.quarantine();
                } else {
                    node.ledger.close_admission();
                }
            }
        }
    }

    pub(super) fn include_consumers(&self, selected: &mut BTreeSet<PluginGenerationId>) {
        loop {
            let providers = selected
                .iter()
                .filter_map(|id| {
                    let generation = &self.generations[id];
                    let binding = generation.binding()?;
                    Some((
                        generation.world.clone(),
                        binding.lock.clone(),
                        binding.digest.clone(),
                        binding.node.clone(),
                    ))
                })
                .collect::<BTreeSet<_>>();
            let before = selected.len();
            for (id, generation) in &self.generations {
                if generation.binding().is_some_and(|binding| {
                    binding.providers.iter().any(|provider| {
                        providers.contains(&(
                            generation.world.clone(),
                            binding.lock.clone(),
                            binding.digest.clone(),
                            provider.clone(),
                        ))
                    })
                }) {
                    selected.insert(id.clone());
                }
            }
            if selected.len() == before {
                break;
            }
        }
    }
}

struct CallPool {
    limits: PackageLimits,
    calls: Arc<Semaphore>,
}

pub(super) struct Generation {
    pub(super) world: WorldRef,
    pub(super) install: InstallId,
    pub(super) kind: GenerationKind,
    pub(super) ledger: ResourceLedger,
}

pub(super) enum GenerationKind {
    Binding(BindingGeneration),
    Materials {
        run: RunId,
        step: StepId,
        implementation: ImplementationRef,
    },
}

pub(super) struct BindingGeneration {
    pub(super) lock: ActivationLockId,
    pub(super) digest: Digest,
    pub(super) node: NodeId,
    pub(super) providers: Vec<NodeId>,
    pub(super) restore_commit: Option<CommitId>,
    pub(super) transfer: Option<Arc<super::TransferHydration>>,
    pub(super) migration_commit: Option<CommitId>,
    pub(super) state: Option<world_protocol::bindings::StateBinding>,
}

impl Generation {
    pub(super) fn binding(&self) -> Option<&BindingGeneration> {
        match &self.kind {
            GenerationKind::Binding(binding) => Some(binding),
            GenerationKind::Materials { .. } => None,
        }
    }
}

/// One live extension registry. Bindings owns the sole publication/admission gate;
/// this mutex protects custody only and is never held across I/O or drain.
pub(crate) struct LiveExtensions {
    pub(super) identity: Arc<()>,
    pub(super) gate: PublicationGate,
    pub(super) registry: Mutex<Registry>,
}

fn require_preparation(
    access: &GateAccess<'_>,
    graph: &BindingGraph,
    channels: &[BindingChannel],
    preparation: Preparation<'_>,
) -> Result<(), LifecycleError> {
    access
        .require_lock_open(&graph.lock().world, &graph.lock().id)
        .map_err(LifecycleError::Gate)?;
    let heads = channels
        .iter()
        .map(|channel| channel.channel.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let domains = graph
        .lock()
        .nodes
        .iter()
        .filter_map(|node| node.state.as_ref().map(|state| state.writer_domain.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    match preparation {
        Preparation::Reserved(_) if heads.is_empty() && domains.is_empty() => {
            return Err(LifecycleError::Gate(
                crate::extensions::bindings::GateFailure::EmptyScope,
            ));
        }
        Preparation::Reserved(commit) => {
            access.require_reserved(&graph.lock().world, commit, &heads, &domains)
        }
        Preparation::Open
        | Preparation::Restore { .. }
        | Preparation::Recovery(_)
        | Preparation::Transfer(_) => access.require_open(&graph.lock().world, &heads, &domains),
    }
    .map_err(LifecycleError::Gate)
}

impl LiveExtensions {
    pub fn new(gate: PublicationGate) -> Self {
        Self {
            identity: Arc::new(()),
            gate,
            registry: Mutex::new(Registry::default()),
        }
    }

    pub fn gate(&self) -> &PublicationGate {
        &self.gate
    }

    pub fn require_world_open(&self, world: &WorldRef) -> Result<(), LifecycleError> {
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            if registry.closing_worlds.contains(world) || registry.stopped_worlds.contains(world) {
                Err(LifecycleError::Retiring)
            } else {
                Ok(())
            }
        })
    }

    pub(super) fn startup_graph(
        &self,
        graph: &BindingGraph,
        channels: &[BindingChannel],
    ) -> Result<Option<Arc<LiveGraph>>, LifecycleError> {
        self.gate.synchronized(|access| {
            require_preparation(access, graph, channels, Preparation::Open)?;
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            let key = (graph.lock().world.clone(), graph.lock().id.clone());
            if registry.closing_worlds.contains(&key.0)
                || registry.stopped_worlds.contains(&key.0)
                || registry.retired.contains(&key)
                || graph.lock().nodes.iter().any(|node| {
                    registry
                        .install_fences
                        .get(&(key.0.clone(), node.implementation.install_id.clone()))
                        .is_some_and(|fence| fence.closing)
                })
            {
                return Err(LifecycleError::Retiring);
            }
            if let Some(current) = registry.exact.get(&key) {
                if current.graph.lock() != graph.lock()
                    || current.channels.len() != channels.len()
                    || current
                        .channels
                        .iter()
                        .any(|channel| !channels.contains(channel))
                {
                    return Err(LifecycleError::InvalidPersistedState);
                }
                if current.nodes.values().any(|node| {
                    node.ledger.snapshot().admission
                        != crate::extensions::invocation::Admission::Open
                }) {
                    return Err(LifecycleError::Retiring);
                }
                return Ok(Some(current.clone()));
            }
            if registry
                .candidates
                .iter()
                .chain(&registry.failed)
                .any(|candidate| {
                    candidate.graph.lock().world == key.0 && candidate.graph.lock().id == key.1
                })
            {
                return Err(LifecycleError::AlreadyPrepared);
            }
            let remaining = registry
                .generations
                .values()
                .filter(|generation| {
                    generation.world == key.0
                        && generation.binding().is_some_and(|binding| binding.lock == key.1)
                })
                .map(|generation| generation.ledger.snapshot())
                .filter(|snapshot| {
                    snapshot.admission != crate::extensions::invocation::Admission::Closed
                })
                .collect::<Vec<_>>();
            if remaining.iter().any(|snapshot| {
                snapshot.admission == crate::extensions::invocation::Admission::Open
            }) {
                return Err(LifecycleError::AlreadyPrepared);
            }
            if !remaining.is_empty() {
                return Err(LifecycleError::Contract(LifecycleFailure::Retained {
                    stage: world_protocol::lifecycle::LifecycleStage::Cleanup,
                    remaining_resources: remaining
                        .iter()
                        .flat_map(super::retained_resources)
                        .collect(),
                }));
            }
            Ok(None)
        })
    }

    pub(super) fn startup_retained(&self, world: &WorldRef) -> Vec<LedgerSnapshot> {
        self.gate.synchronized(|_| {
            self.registry
                .lock()
                .expect("world extension registry poisoned")
                .generations
                .values()
                .filter(|generation| &generation.world == world)
                .map(|generation| generation.ledger.snapshot())
                .filter(|snapshot| {
                    snapshot.admission == crate::extensions::invocation::Admission::Closing
                })
                .collect()
        })
    }

    pub fn invocation_unsettled(&self, world: &WorldRef, invocation: &InvocationId) -> bool {
        self.gate.synchronized(|_| {
            self.registry
                .lock()
                .expect("world extension registry poisoned")
                .generations
                .values()
                .filter(|generation| &generation.world == world)
                .any(|generation| {
                    generation
                        .ledger
                        .snapshot()
                        .resources
                        .iter()
                        .any(|resource| resource.spec.invocation.as_ref() == Some(invocation))
                })
        })
    }

    /// Proves only this original exact closure is settled, not the whole invocation.
    pub(crate) fn invocation_closure_settled(
        &self,
        graph: &BindingGraph,
        closure: &world_protocol::bindings::ExactClosure,
        invocation: &InvocationId,
    ) -> bool {
        self.gate.synchronized(|_| {
            let registry = self.registry.lock().expect("world extension registry poisoned");
            let original = registry.exact.values().chain(&registry.previous)
                .chain(&registry.candidates).chain(&registry.failed)
                .find(|live| live.graph.lock() == graph.lock());
            if original.is_none_or(|live| {
                graph.exact_closure(&closure.root, &live.channels).as_ref() != Ok(closure)
            }) {
                return false;
            }
            closure.nodes.iter().all(|node| {
                let mut ledgers = registry.generations.values().filter(|generation| {
                    generation.world == graph.lock().world && generation.binding().is_some_and(|binding| {
                        binding.lock == graph.lock().id && binding.digest == graph.lock().digest && &binding.node == node
                    })
                }).peekable();
                ledgers.peek().is_some() && ledgers.all(|generation| {
                    !generation.ledger.snapshot().resources.iter()
                        .any(|resource| resource.spec.invocation.as_ref() == Some(invocation))
                })
            })
        })
    }

    pub(crate) fn lock_invocations_unsettled(
        &self,
        world: &WorldRef,
        lock: &ActivationLockId,
    ) -> bool {
        self.gate.synchronized(|_| {
            self.registry
                .lock()
                .expect("world extension registry poisoned")
                .generations
                .values()
                .filter(|generation| {
                    &generation.world == world
                        && generation.binding().is_some_and(|binding| &binding.lock == lock)
                })
                .any(|generation| {
                    let snapshot = generation.ledger.snapshot();
                    snapshot.invocation_inflight != 0
                        || snapshot.acquisitions != 0
                        || snapshot
                            .resources
                            .iter()
                            .any(|resource| resource.spec.invocation.is_some())
                })
        })
    }

    pub fn inspect_process(
        &self,
        world: &WorldRef,
        invocation: &InvocationId,
        node: &NodeId,
    ) -> Option<crate::extensions::process::ProcessInspection> {
        let ledgers = self.gate.synchronized(|_| {
            self.registry
                .lock()
                .expect("world extension registry poisoned")
                .generations
                .values()
                .filter(|generation| {
                    &generation.world == world
                        && generation.binding().is_some_and(|binding| &binding.node == node)
                })
                .map(|generation| generation.ledger.clone())
                .collect::<Vec<_>>()
        });
        let mut matches = ledgers
            .iter()
            .filter(|ledger| ledger.snapshot().resources.iter().any(|resource| {
                resource.spec.kind == ResourceKind::ChildCall
                    && resource.spec.invocation.as_ref() == Some(invocation)
            }));
        let ledger = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        ledger.inspect_process(invocation)
    }

    /// Selects one original held call, never dispatching or manufacturing a new invocation.
    pub fn inspect_process_request(
        &self,
        world: &WorldRef,
        invocation: &InvocationId,
        node: &NodeId,
        request: &world_protocol::slots::SlotRequest,
    ) -> Option<crate::extensions::process::ProcessInspection> {
        let ledgers = self.gate.synchronized(|_| {
            self.registry.lock().expect("world extension registry poisoned")
                .generations.values().filter(|generation| {
                    &generation.world == world
                        && generation.binding().is_some_and(|binding| &binding.node == node)
                }).map(|generation| generation.ledger.clone()).collect::<Vec<_>>()
        });
        let mut selected = None;
        for ledger in ledgers {
            for inspection in ledger.process_inspections(invocation)? {
                if inspection.request() == request {
                    if selected.replace(inspection).is_some() { return None; }
                }
            }
        }
        selected
    }

    /// Reserve custody before the adapter starts any asynchronous resource creation.
    pub(super) fn new_generation_for(
        &self,
        graph: &BindingGraph,
        node: &NodeId,
        channels: &[BindingChannel],
        preparation: Preparation<'_>,
    ) -> Result<ResourceLedger, LifecycleError> {
        self.gate.synchronized(|access| {
            require_preparation(access, graph, channels, preparation)?;
            self.new_generation_in(access, graph, node, preparation)
        })
    }

    fn new_generation_in(
        &self,
        access: &GateAccess<'_>,
        graph: &BindingGraph,
        node: &NodeId,
        preparation: Preparation<'_>,
    ) -> Result<ResourceLedger, LifecycleError> {
        access
            .require_lock_open(&graph.lock().world, &graph.lock().id)
            .map_err(LifecycleError::Gate)?;
        let binding = graph
            .node(node)
            .map_err(|_| LifecycleError::EndpointMismatch(node.clone()))?;
        let domains = graph
            .lock()
            .nodes
            .iter()
            .filter_map(|node| node.state.as_ref().map(|state| state.writer_domain.clone()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        match preparation {
            Preparation::Reserved(commit) => {
                access.require_reserved(&graph.lock().world, commit, &[], &domains)
            }
            Preparation::Open
            | Preparation::Restore { .. }
            | Preparation::Recovery(_)
            | Preparation::Transfer(_) => access.require_open(&graph.lock().world, &[], &domains),
        }
        .map_err(LifecycleError::Gate)?;
        let mut registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        let key = (graph.lock().world.clone(), graph.lock().id.clone());
        let transfer = match preparation {
            Preparation::Transfer(proof) => {
                self.require_transfer_hydration(&registry, proof)?;
                if proof.world() != &key.0 {
                    return Err(LifecycleError::InvalidPersistedState);
                }
                Some(proof.clone())
            }
            _ => None,
        };
        let restore_commit = match preparation {
            Preparation::Transfer(_) => None,
            Preparation::Recovery(proof) => {
                self.require_restore_recovery(&registry, proof)?;
                if proof.world() != &key.0 {
                    return Err(LifecycleError::InvalidPersistedState);
                }
                Some(proof.commit_id().clone())
            }
            Preparation::Restore { intent, drained } => {
                self.require_world_restore(&registry, intent, drained)?;
                if intent.world() != &key.0 {
                    return Err(LifecycleError::InvalidPersistedState);
                }
                Some(intent.commit_id().clone())
            }
            _ if registry.closing_worlds.contains(&key.0) => return Err(LifecycleError::Retiring),
            _ => None,
        };
        if registry.retired.contains(&key)
            || graph.lock().nodes.iter().any(|node| {
                registry
                    .install_fences
                    .get(&(key.0.clone(), node.implementation.install_id.clone()))
                    .is_some_and(|fence| fence.closing)
            })
        {
            return Err(LifecycleError::Retiring);
        }
        let id =
            PluginGenerationId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID generation");
        let ledger = ResourceLedger::new(id.clone());
        registry.generations.insert(
            id,
            Generation {
                world: key.0,
                install: binding.implementation.install_id.clone(),
                kind: GenerationKind::Binding(BindingGeneration {
                    lock: key.1,
                    digest: graph.lock().digest.clone(),
                    node: node.clone(),
                    providers: graph
                        .lock()
                        .edges
                        .iter()
                        .filter(|edge| &edge.consumer == node)
                        .map(|edge| edge.provider.clone())
                        .collect(),
                    restore_commit,
                    transfer,
                    migration_commit: None,
                    state: binding.state.clone(),
                }),
                ledger: ledger.clone(),
            },
        );
        Ok(ledger)
    }

    pub(super) fn prepare_for(
        &self,
        graph: Arc<BindingGraph>,
        channels: Vec<BindingChannel>,
        nodes: Vec<PreparedNode>,
        preparation: Preparation<'_>,
    ) -> Result<PreparedGraph, LifecycleError> {
        self.gate
            .synchronized(|access| self.prepare_in(access, graph, channels, nodes, preparation))
    }

    fn prepare_in(
        &self,
        access: &GateAccess<'_>,
        graph: Arc<BindingGraph>,
        channels: Vec<BindingChannel>,
        nodes: Vec<PreparedNode>,
        preparation: Preparation<'_>,
    ) -> Result<PreparedGraph, LifecycleError> {
        assert!(access.belongs_to(&self.gate));
        let mut indexed = BTreeMap::new();
        let mut duplicate = false;
        // Keep duplicate-node custody too; a rejected candidate must not drop a child.
        let mut extras = Vec::new();
        for node in nodes {
            if let Some(old) = indexed.insert(node.id.clone(), node) {
                extras.push(old);
                duplicate = true;
            }
        }
        let configs = indexed.values().map(|node| node.config.clone()).collect();
        let candidate = Arc::new(LiveGraph {
            graph,
            channels,
            configs,
            nodes: indexed,
            dependencies: Mutex::new(BTreeMap::new()),
            rejected_nodes: extras,
        });
        self.registry
            .lock()
            .expect("world extension registry poisoned")
            .candidates
            .push(candidate.clone());
        let result = (|| {
            require_preparation(access, &candidate.graph, &candidate.channels, preparation)?;
            let restore_commit = {
                let registry = self
                    .registry
                    .lock()
                    .expect("world extension registry poisoned");
                let restore_commit = match preparation {
                    Preparation::Transfer(proof) => {
                        self.require_transfer_hydration(&registry, proof)?;
                        if proof.world() != &candidate.graph.lock().world {
                            return Err(LifecycleError::InvalidPersistedState);
                        }
                        None
                    }
                    Preparation::Recovery(proof) => {
                        self.require_restore_recovery(&registry, proof)?;
                        if proof.world() != &candidate.graph.lock().world {
                            return Err(LifecycleError::InvalidPersistedState);
                        }
                        Some(proof.commit_id().clone())
                    }
                    Preparation::Restore { intent, drained } => {
                        self.require_world_restore(&registry, intent, drained)?;
                        if intent.world() != &candidate.graph.lock().world {
                            return Err(LifecycleError::InvalidPersistedState);
                        }
                        Some(intent.commit_id().clone())
                    }
                    _ if registry
                        .closing_worlds
                        .contains(&candidate.graph.lock().world) =>
                    {
                        return Err(LifecycleError::Retiring);
                    }
                    _ => None,
                };
                if registry.retired.contains(&(
                    candidate.graph.lock().world.clone(),
                    candidate.graph.lock().id.clone(),
                )) || candidate.graph.lock().nodes.iter().any(|node| {
                    registry
                        .install_fences
                        .get(&(
                            candidate.graph.lock().world.clone(),
                            node.implementation.install_id.clone(),
                        ))
                        .is_some_and(|fence| fence.closing)
                }) {
                    return Err(LifecycleError::Retiring);
                }
                restore_commit
            };
            if duplicate {
                return Err(LifecycleError::DuplicateGeneration);
            }
            let fail = |node: &NodeId| LifecycleError::EndpointMismatch(node.clone());
            let mut generations = BTreeSet::new();
            for node in &candidate.graph.lock().nodes {
                let prepared = candidate
                    .nodes
                    .get(&node.id)
                    .ok_or_else(|| fail(&node.id))?;
                if prepared.implementation != node.implementation
                    || prepared.config.install_id != node.implementation.install_id
                    || prepared.config.digest != node.implementation.config_digest
                    || prepared.ledger.snapshot().admission
                        != crate::extensions::invocation::Admission::Open
                    || !generations.insert(prepared.ledger.snapshot().generation)
                {
                    return Err(fail(&node.id));
                }
                {
                    let registry = self
                        .registry
                        .lock()
                        .expect("world extension registry poisoned");
                    let generation = prepared.ledger.snapshot().generation;
                    let reserved = registry
                        .generations
                        .get(&generation)
                        .ok_or_else(|| fail(&node.id))?;
                    let GenerationKind::Binding(binding) = &reserved.kind else {
                        return Err(fail(&node.id));
                    };
                    if reserved.world != candidate.graph.lock().world
                        || binding.lock != candidate.graph.lock().id
                        || binding.digest != candidate.graph.lock().digest
                        || binding.node != node.id
                        || binding.restore_commit != restore_commit
                        || match preparation {
                            Preparation::Transfer(proof) => binding
                                .transfer
                                .as_ref()
                                .is_none_or(|held| !Arc::ptr_eq(held, proof)),
                            _ => binding.transfer.is_some(),
                        }
                        || !reserved.ledger.same_instance(&prepared.ledger)
                    {
                        return Err(fail(&node.id));
                    }
                }
                let calls = self
                    .registry
                    .lock()
                    .expect("world extension registry poisoned")
                    .calls_for(
                        &candidate.graph.lock().world,
                        &node.implementation,
                        prepared.endpoint.limits(),
                    )?;
                prepared
                    .calls
                    .set(calls)
                    .map_err(|_| LifecycleError::AlreadyPrepared)?;
            }
            if candidate.nodes.len() != candidate.graph.lock().nodes.len() {
                return Err(LifecycleError::InvalidPersistedState);
            }
            for root in &candidate.graph.lock().roots {
                candidate
                    .graph
                    .exact_closure(root, &candidate.channels)
                    .map_err(|_| {
                        LifecycleError::Contract(LifecycleFailure::PrepareFailed {
                            node_id: root.clone(),
                        })
                    })?;
            }
            let resources = candidate
                .graph
                .lock()
                .edges
                .iter()
                .map(|edge| {
                    (
                        candidate.nodes[&edge.provider].ledger.clone(),
                        ResourceSpec {
                            token: ResourceToken::try_new(uuid::Uuid::new_v4().to_string())
                                .expect("UUID resource token"),
                            kind: ResourceKind::Dependency,
                            parent: None,
                            invocation: None,
                        },
                    )
                })
                .collect::<Vec<_>>();
            let retained = ResourceLedger::register_batch(&resources)
                .map_err(|_| LifecycleError::Contract(LifecycleFailure::AcquisitionClosed))?;
            let mut dependencies = candidate
                .dependencies
                .lock()
                .expect("world dependency custody poisoned");
            for (edge, registration) in candidate.graph.lock().edges.iter().zip(retained) {
                dependencies
                    .entry(edge.consumer.clone())
                    .or_default()
                    .push(registration);
            }
            drop(dependencies);
            Ok(())
        })();
        match result {
            Ok(()) => Ok(PreparedGraph { inner: candidate }),
            Err(error) => {
                for node in candidate.nodes.values().chain(&candidate.rejected_nodes) {
                    node.ledger.close_admission();
                }
                let mut registry = self
                    .registry
                    .lock()
                    .expect("world extension registry poisoned");
                registry
                    .candidates
                    .retain(|pending| !Arc::ptr_eq(pending, &candidate));
                registry.failed.push(candidate);
                Err(error)
            }
        }
    }

    /// Called only inside Publication::committed/recover_committed. No await,
    /// compilation, authorization or fallible preparation happens after COMMIT.
    pub fn publish(&self, access: &GateAccess<'_>, prepared: PreparedGraph) {
        assert!(
            access.belongs_to(&self.gate),
            "publication must use the one admission gate"
        );
        let mut registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        registry
            .candidates
            .retain(|candidate| !Arc::ptr_eq(candidate, &prepared.inner));
        let key = (
            prepared.inner.graph.lock().world.clone(),
            prepared.inner.graph.lock().id.clone(),
        );
        if let Some(previous) = registry.exact.insert(key, prepared.inner) {
            registry.previous.push(previous);
        }
        // An ordinary upgrade never closes old exact locks: old runs keep their pins.
    }

    pub fn acquire(
        &self,
        world: &WorldRef,
        lock: &ActivationLockId,
        root: &NodeId,
        invocation: InvocationId,
        at: Timestamp,
    ) -> Result<InvocationLease, LeaseFailure> {
        self.gate
            .synchronized(|access| self.acquire_in(access, world, lock, root, invocation, at))
    }

    pub fn acquire_in(
        &self,
        access: &GateAccess<'_>,
        world: &WorldRef,
        lock: &ActivationLockId,
        root: &NodeId,
        invocation: InvocationId,
        at: Timestamp,
    ) -> Result<InvocationLease, LeaseFailure> {
        assert!(
            access.belongs_to(&self.gate),
            "acquisition must use the one admission gate"
        );
        access
            .require_lock_open(world, lock)
            .map_err(LeaseFailure::Gate)?;
        let registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        if registry.closing_worlds.contains(world)
            || registry.retired.contains(&(world.clone(), lock.clone()))
        {
            return Err(LeaseFailure::Admission(
                crate::extensions::invocation::AdmissionFailure::Closed,
            ));
        }
        let live = registry
            .exact
            .get(&(world.clone(), lock.clone()))
            .ok_or_else(|| LeaseFailure::MissingGeneration(root.clone()))?;
        let nodes = live
            .nodes
            .iter()
            .map(|(id, node)| {
                (
                    id.clone(),
                    (
                        node.ledger.clone(),
                        node.endpoint.clone(),
                        node.calls.get().expect("prepared call pool").clone(),
                    ),
                )
            })
            .collect();
        InvocationLease::acquire(
            access,
            live.graph.clone(),
            &live.channels,
            root,
            &nodes,
            invocation,
            at,
        )
    }

    /// Rejected/rolled-back preparation only. Never closes the current selection.
    pub fn retire_candidate(&self, access: &GateAccess<'_>, prepared: &PreparedGraph) {
        assert!(
            access.belongs_to(&self.gate),
            "retirement must use the one admission gate"
        );
        for node in prepared
            .inner
            .nodes
            .values()
            .chain(&prepared.inner.rejected_nodes)
        {
            node.ledger.close_admission();
        }
        let mut registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        registry
            .candidates
            .retain(|candidate| !Arc::ptr_eq(candidate, &prepared.inner));
        if !registry
            .failed
            .iter()
            .any(|candidate| Arc::ptr_eq(candidate, &prepared.inner))
        {
            registry.failed.push(prepared.inner.clone());
        }
    }

    pub async fn drain_candidate(
        &self,
        prepared: &PreparedGraph,
        deadline: Instant,
    ) -> Vec<LedgerSnapshot> {
        let remaining = drain_graph(&prepared.inner, deadline).await;
        if remaining.is_empty() {
            let mut registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            registry
                .candidates
                .retain(|candidate| !Arc::ptr_eq(candidate, &prepared.inner));
            registry
                .failed
                .retain(|candidate| !Arc::ptr_eq(candidate, &prepared.inner));
        }
        remaining
    }

    pub async fn drain_failed_until(&self, deadline: Instant) -> Vec<LedgerSnapshot> {
        self.drain_failed_in(None, deadline).await
    }

    pub async fn drain_failed_world_until(
        &self,
        world: &WorldRef,
        deadline: Instant,
    ) -> Vec<LedgerSnapshot> {
        self.drain_failed_in(Some(world), deadline).await
    }

    async fn drain_failed_in(
        &self,
        world: Option<&WorldRef>,
        deadline: Instant,
    ) -> Vec<LedgerSnapshot> {
        let failed = self
            .registry
            .lock()
            .expect("world extension registry poisoned")
            .failed
            .iter()
            .filter(|candidate| world.is_none_or(|world| &candidate.graph.lock().world == world))
            .cloned()
            .collect::<Vec<_>>();
        let mut remaining = Vec::new();
        for candidate in failed {
            let retained = drain_graph(&candidate, deadline).await;
            if retained.is_empty() {
                self.registry
                    .lock()
                    .expect("world extension registry poisoned")
                    .failed
                    .retain(|pending| !Arc::ptr_eq(pending, &candidate));
            } else {
                remaining.extend(retained);
            }
        }
        let orphans = {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            let referenced = registry
                .candidates
                .iter()
                .chain(&registry.failed)
                .chain(&registry.previous)
                .chain(registry.exact.values())
                .flat_map(|graph| graph.nodes.values().chain(&graph.rejected_nodes))
                .map(|node| node.ledger.snapshot().generation)
                .collect::<BTreeSet<_>>();
            registry
                .generations
                .iter()
                .filter(|(id, generation)| {
                    world.is_none_or(|world| &generation.world == world)
                        && !referenced.contains(*id)
                        && generation.ledger.snapshot().admission
                            != crate::extensions::invocation::Admission::Open
                })
                .map(|(_, generation)| generation.ledger.clone())
                .collect::<Vec<_>>()
        };
        for ledger in orphans {
            let _ = ledger.request_cancel();
            if !matches!(
                ledger.drain_until(deadline).await,
                Ok(DrainOutcome::Drained)
            ) {
                remaining.push(ledger.snapshot());
            }
        }
        remaining
    }

    pub fn close_all(&self, world: &WorldRef, quarantine: bool) {
        self.gate.synchronized(|_| {
            let mut registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            registry.stopped_worlds.insert(world.clone());
            registry.close_world(world, quarantine);
        });
    }

    pub fn process_failures(
        &self,
        world: &WorldRef,
    ) -> Vec<Arc<crate::extensions::process::ProcessError>> {
        let registry = self
            .registry
            .lock()
            .expect("world extension registry poisoned");
        let mut failures = Vec::new();
        for graph in registry
            .candidates
            .iter()
            .chain(&registry.failed)
            .chain(&registry.previous)
            .chain(registry.exact.values())
            .filter(|graph| &graph.graph.lock().world == world)
        {
            for failure in graph.process_failures(None) {
                if !failures.iter().any(|prior| Arc::ptr_eq(prior, &failure)) {
                    failures.push(failure);
                }
            }
        }
        failures
    }

    /// Close entrances first, durably checkpoint accepted work, then call this.
    /// A failed consumer retains provider dependencies and all cleanup custody.
    pub async fn drain_until(&self, world: &WorldRef, deadline: Instant) -> Vec<LedgerSnapshot> {
        let (graphs, generations) = self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            let graphs = registry
                .candidates
                .iter()
                .chain(registry.failed.iter())
                .chain(registry.previous.iter())
                .chain(registry.exact.values())
                .filter(|live| &live.graph.lock().world == world)
                .cloned()
                .collect::<Vec<_>>();
            let generations = registry
                .generations
                .values()
                .filter(|generation| &generation.world == world)
                .map(|generation| generation.ledger.clone())
                .collect::<Vec<_>>();
            (graphs, generations)
        });
        for ledger in &generations {
            let _ = ledger.request_cancel();
        }
        let mut remaining =
            futures_util::future::join_all(graphs.iter().map(|live| drain_graph(live, deadline)))
                .await
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
        for ledger in generations {
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
        remaining
    }
}

pub(super) async fn drain_graph(live: &LiveGraph, deadline: Instant) -> Vec<LedgerSnapshot> {
    // Signal all already-closed generations before waiting on any one consumer.
    for node in live.nodes.values().chain(&live.rejected_nodes) {
        let _ = node.ledger.request_cancel();
    }
    let mut remaining = Vec::new();
    for node in live.rejected_nodes.iter().chain(
        live.nodes
            .iter()
            .filter(|(id, _)| live.graph.node(id).is_err())
            .map(|(_, node)| node),
    ) {
        if !matches!(
            node.ledger.drain_until(deadline).await,
            Ok(DrainOutcome::Drained)
        ) {
            remaining.push(node.ledger.snapshot());
        }
    }
    for id in live.graph.prepare_order().iter().rev() {
        let Some(node) = live.nodes.get(id) else {
            continue;
        };
        match node.ledger.drain_until(deadline).await {
            Ok(DrainOutcome::Drained) => {
                let dependencies = live
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
            _ => remaining.push(node.ledger.snapshot()),
        }
    }
    remaining
}
