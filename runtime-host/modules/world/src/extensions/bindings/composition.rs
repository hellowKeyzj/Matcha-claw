use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    bindings::{BindingFailure, BindingNode, Composition, CompositionFailurePolicy,
        CompositionMode, DataflowProjection, MergePolicy, SlotKind},
    ids::NodeId,
};

use super::graph::{port, provider_order};

pub(super) fn validate(
    composition: &Composition, all_nodes: &[BindingNode], index: &BTreeMap<NodeId, usize>,
) -> Result<(), BindingFailure> {
    let invalid = || BindingFailure::InvalidComposition { binding_id: composition.binding_id.clone() };
    let members: BTreeSet<_> = composition.nodes.iter().cloned().collect();
    if members.is_empty() || members.len() != composition.nodes.len() { return Err(invalid()) }
    let mut nodes = Vec::with_capacity(members.len());
    for member in &composition.nodes {
        let node = index.get(member).map(|index| &all_nodes[*index])
            .ok_or_else(|| BindingFailure::MissingNode { node_id: member.clone() })?;
        if node.binding_id != composition.binding_id { return Err(invalid()) }
        nodes.push(node);
    }
    let slot = nodes[0].slot;
    if nodes.iter().any(|node| node.slot != slot) { return Err(invalid()) }
    if slot == SlotKind::Policy {
        if composition.merge != MergePolicy::MandatoryAndDenyOverrides
            || composition.failure != CompositionFailurePolicy::FailClosed {
            return Err(BindingFailure::MergePolicyRequired { binding_id: composition.binding_id.clone() });
        }
    } else if composition.merge == MergePolicy::MandatoryAndDenyOverrides {
        return Err(invalid());
    }
    if members.len() > 1 && matches!(slot, SlotKind::Compiler | SlotKind::Resolver)
        && composition.mode != CompositionMode::TypedDag { return Err(invalid()) }
    if members.len() > 1 && composition.merge == MergePolicy::None
        && composition.mode != CompositionMode::Chain {
        return Err(BindingFailure::MergePolicyRequired { binding_id: composition.binding_id.clone() });
    }
    let ordered: BTreeSet<_> = composition.order.iter().cloned().collect();
    if !composition.order.is_empty()
        && (ordered != members || ordered.len() != composition.order.len()) { return Err(invalid()) }
    match composition.mode {
        CompositionMode::Single => {
            if members.len() != 1 || !composition.wiring.is_empty() { return Err(invalid()) }
        }
        CompositionMode::Ordered | CompositionMode::Chain => {
            if ordered != members { return Err(invalid()) }
        }
        CompositionMode::TypedDag | CompositionMode::FanOut => {}
    }
    if composition.merge == MergePolicy::OrderedConcatenation && ordered != members { return Err(invalid()) }
    if composition.mode == CompositionMode::FanOut && !composition.wiring.is_empty() { return Err(invalid()) }
    let mut dependencies: BTreeMap<NodeId, Vec<NodeId>> = members.iter().cloned().map(|id| (id, Vec::new())).collect();
    let mut inputs = BTreeSet::new();
    let mut pairs = BTreeSet::new();
    for edge in &composition.wiring {
        if !members.contains(&edge.output_node) || !members.contains(&edge.input_node) { return Err(invalid()) }
        let output = &all_nodes[index[&edge.output_node]];
        let input = &all_nodes[index[&edge.input_node]];
        let output_port = port(output, &edge.output_port)?;
        let input_port = port(input, &edge.input_port)?;
        match edge.projection {
            DataflowProjection::CompilerIr => {
                let method = world_protocol::slots::slot_port(SlotKind::Compiler)
                    .map_err(|_| BindingFailure::InternalFault)?;
                let schema = world_protocol::schema::digest::<world_protocol::compiler::TypedIr>()
                    .map_err(|_| BindingFailure::InternalFault)?;
                if output.slot != SlotKind::Compiler || input.slot != SlotKind::Compiler
                    || output_port != &method || input_port != &method || edge.schema_digest != schema {
                    return Err(BindingFailure::SchemaMismatch { consumer: input.id.clone(), provider: output.id.clone() });
                }
            }
        }
        // A typed method input has one complete value; multiple upstream writers
        // require a declared merger node, not an implicit last-return-wins merge.
        if !inputs.insert((edge.input_node.clone(), edge.input_port.clone())) { return Err(invalid()) }
        dependencies.get_mut(&edge.input_node).expect("member input").push(edge.output_node.clone());
        pairs.insert((edge.output_node.clone(), edge.input_node.clone()));
        if !composition.order.is_empty() {
            let output_index = composition.order.iter().position(|id| id == &edge.output_node).expect("ordered member");
            let input_index = composition.order.iter().position(|id| id == &edge.input_node).expect("ordered member");
            if output_index >= input_index { return Err(invalid()) }
        }
    }
    provider_order(&dependencies).map_err(|nodes| BindingFailure::DataflowCycle { nodes })?;
    if composition.mode == CompositionMode::Chain {
        let expected: BTreeSet<_> = composition.order.windows(2)
            .map(|pair| (pair[0].clone(), pair[1].clone())).collect();
        if pairs != expected { return Err(invalid()) }
    }
    Ok(())
}
