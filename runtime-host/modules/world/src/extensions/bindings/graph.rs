use std::{collections::{BTreeMap, BTreeSet}, sync::LazyLock};

use world_protocol::{
    bindings::{ActivationLock, BindingChannel, BindingFailure, BindingNode,
        CompositionMode, ExactClosure, MethodPort, PortDirection, SlotKind, TrustClass},
    ids::{BindingId, NodeId, StateNamespaceId, WriterDomain},
    process::{HostImport, host_import_port},
};

use super::composition;

static HOST_PORTS: LazyLock<Result<BTreeMap<String, MethodPort>, BindingFailure>> = LazyLock::new(|| {
    [HostImport::WorldRead, HostImport::ModelGenerate, HostImport::StateRead,
        HostImport::StateWrite, HostImport::Clock, HostImport::Log].into_iter()
        .map(|import| host_import_port(import).map(|port| (port.name.clone(), port)))
        .collect::<Result<_, _>>().map_err(|_| BindingFailure::InternalFault)
});

/// Validated immutable selection graph. Package availability, current authority,
/// current trust and writer admission are checked by their owners, not cached here.
pub(crate) struct BindingGraph {
    lock: ActivationLock,
    nodes: BTreeMap<NodeId, usize>,
    dependencies: BTreeMap<NodeId, Vec<NodeId>>,
    composition: BTreeMap<BindingId, usize>,
    prepare_order: Vec<NodeId>,
}

impl BindingGraph {
    pub fn validate(lock: ActivationLock) -> Result<Self, BindingFailure> {
        if world_protocol::bindings::activation_lock_digest(&lock)? != lock.digest {
            return Err(BindingFailure::DigestMismatch);
        }
        if lock.nodes.is_empty() && lock.edges.is_empty() && lock.compositions.is_empty()
            && lock.roots.is_empty() && lock.trusted_roots.is_empty() {
            return Ok(Self { lock, nodes: BTreeMap::new(), dependencies: BTreeMap::new(),
                composition: BTreeMap::new(), prepare_order: Vec::new() });
        }
        let host_ports = HOST_PORTS.as_ref().map_err(Clone::clone)?;
        let mut nodes = BTreeMap::new();
        let mut dependencies: BTreeMap<_, Vec<_>> = BTreeMap::new();
        for (index, node) in lock.nodes.iter().enumerate() {
            if nodes.insert(node.id.clone(), index).is_some() {
                return Err(BindingFailure::DuplicateNode { node_id: node.id.clone() });
            }
            dependencies.insert(node.id.clone(), Vec::new());
            validate_node(node, &lock)?;
            for import in node.ports.iter().filter(|port| port.direction == PortDirection::Import) {
                if let Some(expected) = host_ports.get(&import.name)
                    .or_else(|| host_ports.get(import.contract.id.as_str())) {
                    if import.name != expected.name || import.contract != expected.contract
                        || import.request_schema != expected.request_schema
                        || import.result_schema != expected.result_schema {
                        return Err(BindingFailure::ContractMismatch {
                            consumer: node.id.clone(), provider: node.id.clone(), contract: import.contract.clone(),
                        });
                    }
                }
            }
        }
        let node = |id: &NodeId| nodes.get(id).map(|index| &lock.nodes[*index])
            .ok_or_else(|| BindingFailure::MissingNode { node_id: id.clone() });
        let mut selections = BTreeSet::new();
        for edge in &lock.edges {
            let consumer = node(&edge.consumer)?;
            let provider = node(&edge.provider)?;
            let import = port(consumer, &edge.consumer_port)?;
            let export = port(provider, &edge.provider_port)?;
            if import.direction != PortDirection::Import || export.direction != PortDirection::Export
                || host_ports.contains_key(&import.name) || host_ports.contains_key(import.contract.id.as_str())
                || import.contract != edge.contract || export.contract != edge.contract {
                return Err(BindingFailure::ContractMismatch {
                    consumer: consumer.id.clone(), provider: provider.id.clone(), contract: edge.contract.clone(),
                });
            }
            if import.request_schema != export.request_schema || import.result_schema != export.result_schema {
                return Err(BindingFailure::SchemaMismatch { consumer: consumer.id.clone(), provider: provider.id.clone() });
            }
            if !selections.insert((consumer.id.clone(), import.name.clone())) {
                // An import selects one provider. Multi-provider algorithms are explicit
                // composition nodes, never repeated edges with last-return-wins.
                return Err(BindingFailure::AmbiguousProvider {
                    consumer: consumer.id.clone(), port: import.name.clone(),
                    providers: lock.edges.iter().filter(|candidate| candidate.consumer == consumer.id
                        && candidate.consumer_port == import.name).map(|candidate| candidate.provider.clone()).collect(),
                });
            }
            if import.required != edge.required {
                return Err(BindingFailure::MissingRequiredProvider { consumer: consumer.id.clone(), contract: import.contract.clone() });
            }
            dependencies.get_mut(&edge.consumer).expect("indexed consumer").push(edge.provider.clone());
        }
        for consumer in &lock.nodes {
            for import in consumer.ports.iter().filter(|port| port.direction == PortDirection::Import && port.required) {
                if !host_ports.contains_key(&import.name)
                    && !selections.contains(&(consumer.id.clone(), import.name.clone())) {
                    return Err(BindingFailure::MissingRequiredProvider { consumer: consumer.id.clone(), contract: import.contract.clone() });
                }
            }
        }
        let prepare_order = provider_order(&dependencies).map_err(|nodes| BindingFailure::DependencyCycle { nodes })?;
        let mut compositions = BTreeMap::new();
        for (index, current) in lock.compositions.iter().enumerate() {
            if compositions.insert(current.binding_id.clone(), index).is_some() {
                return Err(BindingFailure::InvalidComposition { binding_id: current.binding_id.clone() });
            }
            composition::validate(current, &lock.nodes, &nodes)?;
        }
        for current in &lock.nodes {
            let Some(index) = compositions.get(&current.binding_id) else {
                return Err(BindingFailure::InvalidComposition { binding_id: current.binding_id.clone() });
            };
            if !lock.compositions[*index].nodes.contains(&current.id) {
                return Err(BindingFailure::InvalidComposition { binding_id: current.binding_id.clone() });
            }
        }
        let mut compiler_binding = None;
        for current in lock.nodes.iter().filter(|node| node.slot == SlotKind::Compiler) {
            let selected = &lock.compositions[compositions[&current.binding_id]];
            if compiler_binding.is_some_and(|binding| binding != &current.binding_id)
                || !matches!(selected.mode, CompositionMode::Single | CompositionMode::TypedDag) {
                return Err(BindingFailure::InvalidComposition { binding_id: current.binding_id.clone() });
            }
            compiler_binding = Some(&current.binding_id);
        }
        validate_state(&lock)?;
        let graph = Self { lock, nodes, dependencies, composition: compositions, prepare_order };
        if graph.lock.roots.is_empty()
            || graph.lock.roots.iter().collect::<BTreeSet<_>>().len() != graph.lock.roots.len()
            || graph.lock.trusted_roots.iter().collect::<BTreeSet<_>>().len() != graph.lock.trusted_roots.len() {
            return Err(BindingFailure::InvalidRoots);
        }
        for root in graph.lock.roots.iter().chain(&graph.lock.trusted_roots) { graph.node(root)?; }
        let mut reachable = BTreeSet::new();
        for root in &graph.lock.roots { reachable.extend(graph.closure_nodes(root)?); }
        if reachable.len() != graph.nodes.len() { return Err(BindingFailure::InvalidRoots) }
        for root in &graph.lock.trusted_roots {
            let selected = graph.node(root)?;
            for member in graph.members(&selected.binding_id) {
                if graph.node(member)?.trust == TrustClass::OrdinaryGuest {
                    return Err(BindingFailure::TrustBoundary { node_id: member.clone() });
                }
            }
        }
        Ok(graph)
    }

    pub fn lock(&self) -> &ActivationLock { &self.lock }

    pub fn node(&self, id: &NodeId) -> Result<&BindingNode, BindingFailure> {
        self.nodes.get(id).map(|index| &self.lock.nodes[*index])
            .ok_or_else(|| BindingFailure::MissingNode { node_id: id.clone() })
    }

    /// Providers precede their consumers; reversing this order is not drain proof.
    pub fn prepare_order(&self) -> &[NodeId] { &self.prepare_order }

    pub fn composition(&self, binding: &BindingId) -> Result<&world_protocol::bindings::Composition, BindingFailure> {
        self.composition.get(binding).map(|index| &self.lock.compositions[*index])
            .ok_or_else(|| BindingFailure::InvalidComposition { binding_id: binding.clone() })
    }

    pub fn composition_order(&self, binding: &BindingId) -> Result<Vec<NodeId>, BindingFailure> {
        let composition = self.composition(binding)?;
        if !composition.order.is_empty() { return Ok(composition.order.clone()); }
        let mut dependencies: BTreeMap<_, Vec<_>> = composition.nodes.iter().cloned()
            .map(|id| (id, Vec::new())).collect();
        for edge in &composition.wiring {
            dependencies.get_mut(&edge.input_node).expect("validated wiring input").push(edge.output_node.clone());
        }
        provider_order(&dependencies).map_err(|nodes| BindingFailure::DataflowCycle { nodes })
    }

    /// A root retains its whole composition, mandatory trust roots, and recursively
    /// every selected dependency/composition. No inventory enumeration or latest read.
    pub fn exact_closure(
        &self, root: &NodeId, channels: &[BindingChannel],
    ) -> Result<ExactClosure, BindingFailure> {
        let selected = self.closure_nodes(root)?;
        let bindings: BTreeSet<_> = selected.iter().map(|id| self.node(id).expect("selected node").binding_id.clone()).collect();
        let mut heads = BTreeSet::new();
        for binding in &bindings {
            let mapped: BTreeSet<_> = channels.iter().filter(|mapping| &mapping.binding_id == binding)
                .map(|mapping| mapping.channel.clone()).collect();
            if mapped.len() != 1 {
                return Err(BindingFailure::InvalidChannels { binding_id: binding.clone() });
            }
            heads.extend(mapped);
        }
        let domains = selected.iter().filter_map(|id| self.node(id).expect("selected node").state.as_ref()
            .map(|state| state.writer_domain.clone())).collect::<BTreeSet<_>>();
        Ok(ExactClosure {
            activation_lock_id: self.lock.id.clone(), root: root.clone(),
            nodes: self.prepare_order.iter().filter(|id| selected.contains(*id)).cloned().collect(),
            edges: self.lock.edges.iter().filter(|edge| selected.contains(&edge.consumer)).cloned().collect(),
            affected_bindings: bindings.into_iter().collect(), affected_heads: heads.into_iter().collect(),
            affected_domains: domains.into_iter().collect(),
        })
    }

    /// Reverse dependency impact, including whole compositions and shared writer
    /// domains. A provider update cannot publish only one of its dependent heads.
    pub fn affected_nodes(&self, changed: &[NodeId]) -> Result<Vec<NodeId>, BindingFailure> {
        let mut affected = BTreeSet::new();
        let mut pending = changed.to_vec();
        while let Some(id) = pending.pop() {
            let node = self.node(&id)?;
            if !affected.insert(id.clone()) { continue }
            pending.extend(self.members(&node.binding_id).iter().cloned());
            for edge in self.lock.edges.iter().filter(|edge| edge.provider == id) {
                pending.push(edge.consumer.clone());
            }
            if let Some(state) = &node.state {
                pending.extend(self.lock.nodes.iter().filter(|other| other.state.as_ref()
                    .is_some_and(|other| other.writer_domain == state.writer_domain)).map(|other| other.id.clone()));
            }
        }
        Ok(self.prepare_order.iter().filter(|id| affected.contains(*id)).cloned().collect())
    }

    fn members(&self, binding: &BindingId) -> &[NodeId] {
        &self.lock.compositions[self.composition[binding]].nodes
    }

    pub(crate) fn closure_nodes(&self, root: &NodeId) -> Result<BTreeSet<NodeId>, BindingFailure> {
        self.node(root)?;
        let mut selected = BTreeSet::new();
        let mut pending = vec![root.clone()];
        pending.extend(self.lock.trusted_roots.iter().cloned());
        while let Some(id) = pending.pop() {
            let node = self.node(&id)?;
            if !selected.insert(id.clone()) { continue }
            pending.extend(self.members(&node.binding_id).iter().cloned());
            pending.extend(self.dependencies[&id].iter().cloned());
        }
        Ok(selected)
    }
}

pub(super) fn port<'a>(node: &'a BindingNode, name: &str) -> Result<&'a world_protocol::bindings::MethodPort, BindingFailure> {
    node.ports.iter().find(|port| port.name == name)
        .ok_or_else(|| BindingFailure::MissingPort { node_id: node.id.clone(), port: name.into() })
}

fn validate_node(node: &BindingNode, lock: &ActivationLock) -> Result<(), BindingFailure> {
    let mut ports = BTreeSet::new();
    for port in &node.ports {
        if !ports.insert(&port.name) {
            return Err(BindingFailure::DuplicatePort { node_id: node.id.clone(), port: port.name.clone() });
        }
        if port.name.is_empty() || !node.implementation.contracts.contains(&port.contract) {
            return Err(BindingFailure::ContractMismatch {
                consumer: node.id.clone(), provider: node.id.clone(), contract: port.contract.clone(),
            });
        }
    }
    if node.state.as_ref().is_some_and(|state| state.root.world != lock.world) {
        return Err(BindingFailure::StateConflict { node_id: node.id.clone() });
    }
    Ok(())
}

fn validate_state(lock: &ActivationLock) -> Result<(), BindingFailure> {
    let mut namespaces: BTreeMap<StateNamespaceId, _> = BTreeMap::new();
    let mut epochs: BTreeMap<WriterDomain, _> = BTreeMap::new();
    for node in &lock.nodes {
        let Some(state) = &node.state else { continue };
        if namespaces.get(&state.namespace).is_some_and(|previous| previous != &state)
            || epochs.get(&state.writer_domain).is_some_and(|epoch| epoch != &state.writer_epoch) {
            return Err(BindingFailure::StateConflict { node_id: node.id.clone() });
        }
        namespaces.insert(state.namespace.clone(), state);
        epochs.insert(state.writer_domain.clone(), state.writer_epoch);
    }
    Ok(())
}

/// Iterative Kahn traversal avoids stack exhaustion on untrusted package graphs.
/// The error contains one actual cycle, not downstream nodes blocked by that cycle.
pub(super) fn provider_order(
    dependencies: &BTreeMap<NodeId, Vec<NodeId>>,
) -> Result<Vec<NodeId>, Vec<NodeId>> {
    let mut counts = BTreeMap::new();
    let mut consumers: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
    let mut ready = BTreeSet::new();
    for (consumer, providers) in dependencies {
        let unique: BTreeSet<_> = providers.iter().collect();
        counts.insert(consumer.clone(), unique.len());
        if unique.is_empty() { ready.insert(consumer.clone()); }
        for provider in unique { consumers.entry(provider.clone()).or_default().push(consumer.clone()); }
    }
    let mut ordered = Vec::with_capacity(dependencies.len());
    while let Some(provider) = ready.pop_first() {
        ordered.push(provider.clone());
        if let Some(dependents) = consumers.get(&provider) {
            for consumer in dependents {
                let remaining = counts.get_mut(consumer).expect("indexed consumer");
                *remaining -= 1;
                if *remaining == 0 { ready.insert(consumer.clone()); }
            }
        }
    }
    if ordered.len() == dependencies.len() { return Ok(ordered) }
    let mut current = counts.iter().find(|(_, count)| **count > 0).expect("cycle exists").0.clone();
    let mut path = Vec::new();
    let mut positions = BTreeMap::new();
    loop {
        if let Some(position) = positions.insert(current.clone(), path.len()) {
            return Err(path[position..].to_vec());
        }
        path.push(current.clone());
        current = dependencies[&current].iter().find(|provider| counts[*provider] > 0)
            .expect("remaining node has remaining provider").clone();
    }
}
