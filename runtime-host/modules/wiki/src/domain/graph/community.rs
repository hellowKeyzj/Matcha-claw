use std::collections::BTreeMap;

use super::{WikiGraphCommunity, WikiGraphReceipt};

// Weighted undirected Louvain: local modularity moves followed by graph aggregation.
// Resolution is 1, as in the original graphology community analysis.
pub(super) fn assign(graph: &mut WikiGraphReceipt) {
    let positions = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    let mut adjacency = vec![BTreeMap::<usize, f64>::new(); graph.nodes.len()];
    for edge in &graph.edges {
        let (Some(&source), Some(&target)) = (
            positions.get(edge.from.as_str()),
            positions.get(edge.to.as_str()),
        ) else {
            continue;
        };
        *adjacency[source].entry(target).or_default() += edge.weight;
        *adjacency[target].entry(source).or_default() += edge.weight;
    }
    let mut assignments = (0..graph.nodes.len()).collect::<Vec<_>>();
    loop {
        let communities = local_moves(&adjacency);
        let count = communities.iter().copied().max().map_or(0, |id| id + 1);
        for assignment in &mut assignments {
            *assignment = communities[*assignment];
        }
        if count == adjacency.len() {
            break;
        }
        let mut aggregated = vec![BTreeMap::new(); count];
        for (source, neighbors) in adjacency.iter().enumerate() {
            for (&target, &weight) in neighbors {
                *aggregated[communities[source]]
                    .entry(communities[target])
                    .or_default() += weight;
            }
        }
        adjacency = aggregated;
    }
    let count = assignments.iter().copied().max().map_or(0, |id| id + 1);
    let mut groups = vec![Vec::new(); count];
    for (index, &community) in assignments.iter().enumerate() {
        groups[community].push(index);
    }
    let mut internal = vec![0usize; count];
    for edge in &graph.edges {
        let (Some(&source), Some(&target)) = (
            positions.get(edge.from.as_str()),
            positions.get(edge.to.as_str()),
        ) else {
            continue;
        };
        if assignments[source] == assignments[target] {
            internal[assignments[source]] += 1;
        }
    }
    let mut order = (0..count).collect::<Vec<_>>();
    order.sort_by_key(|community| std::cmp::Reverse(groups[*community].len()));
    let mut remap = vec![0; count];
    graph.communities = order
        .into_iter()
        .enumerate()
        .map(|(id, previous)| {
            remap[previous] = id;
            let members = &mut groups[previous];
            members.sort_by_key(|index| std::cmp::Reverse(graph.nodes[*index].link_count));
            let node_count = members.len();
            let possible_edges = if node_count > 1 {
                node_count as f64 * (node_count - 1) as f64 / 2.0
            } else {
                1.0
            };
            WikiGraphCommunity {
                id,
                node_count,
                cohesion: internal[previous] as f64 / possible_edges,
                top_nodes: members
                    .iter()
                    .take(5)
                    .map(|index| graph.nodes[*index].label.clone())
                    .collect(),
            }
        })
        .collect();
    for (node, community) in graph.nodes.iter_mut().zip(assignments) {
        node.community = remap[community];
    }
}

fn local_moves(adjacency: &[BTreeMap<usize, f64>]) -> Vec<usize> {
    let degrees = adjacency
        .iter()
        .map(|neighbors| neighbors.values().sum::<f64>())
        .collect::<Vec<_>>();
    let total_weight: f64 = degrees.iter().sum();
    let mut assignments = (0..adjacency.len()).collect::<Vec<_>>();
    if total_weight == 0.0 {
        return assignments;
    }
    let mut totals = degrees.clone();
    let mut sizes = vec![1usize; adjacency.len()];
    let mut empty = std::collections::BTreeSet::new();
    loop {
        let mut moved = false;
        for (node, neighbors) in adjacency.iter().enumerate() {
            if degrees[node] == 0.0 {
                continue;
            }
            let current = assignments[node];
            let mut weights = BTreeMap::<usize, f64>::new();
            for (&neighbor, &weight) in neighbors {
                if neighbor != node {
                    *weights.entry(assignments[neighbor]).or_default() += weight;
                }
            }
            totals[current] -= degrees[node];
            sizes[current] -= 1;
            if sizes[current] == 0 {
                empty.insert(current);
            }
            let gain = |community: usize, weight: f64| {
                weight - degrees[node] * totals[community] / total_weight
            };
            let mut best = current;
            let mut best_gain = gain(current, weights.get(&current).copied().unwrap_or_default());
            // Removing a node into a singleton must remain possible after earlier merges.
            if let Some(&singleton) = empty.first() {
                if best_gain < -1e-12 {
                    best = singleton;
                    best_gain = 0.0;
                }
            }
            for (&community, &weight) in &weights {
                let candidate = gain(community, weight);
                if candidate > best_gain + 1e-12 {
                    best = community;
                    best_gain = candidate;
                }
            }
            assignments[node] = best;
            totals[best] += degrees[node];
            sizes[best] += 1;
            empty.remove(&best);
            moved |= best != current;
        }
        if !moved {
            break;
        }
    }
    let mut remap = BTreeMap::new();
    for assignment in &mut assignments {
        let next = remap.len();
        *assignment = *remap.entry(*assignment).or_insert(next);
    }
    assignments
}
