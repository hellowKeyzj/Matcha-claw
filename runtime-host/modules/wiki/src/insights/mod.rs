mod research;

use crate::{WikiFailure, domain::WikiGraphReceipt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub(crate) use research::{parse_research_input, research_request};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiGraphInsightInput {
    pub project_id: Option<String>,
    pub insight_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiGraphInsightResearchInput {
    pub project_id: Option<String>,
    pub insight_key: String,
    pub model_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphInsightResearchReceipt {
    pub project_id: String,
    pub insight_key: String,
    pub topic: String,
    pub search_queries: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSurprisingConnection {
    pub key: String,
    pub source_id: String,
    pub target_id: String,
    pub score: u32,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WikiKnowledgeGapType {
    IsolatedNode,
    SparseCommunity,
    BridgeNode,
}

impl WikiKnowledgeGapType {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::IsolatedNode => "isolated-node",
            Self::SparseCommunity => "sparse-community",
            Self::BridgeNode => "bridge-node",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiKnowledgeGap {
    pub key: String,
    pub r#type: WikiKnowledgeGapType,
    pub title: String,
    pub description: String,
    pub node_ids: Vec<String>,
    pub suggestion: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphInsightsReceipt {
    pub project_id: String,
    pub surprising_connections: Vec<WikiSurprisingConnection>,
    pub knowledge_gaps: Vec<WikiKnowledgeGap>,
    pub dismissed_keys: BTreeSet<String>,
}

pub(crate) fn analyze(graph: &WikiGraphReceipt, project_id: &str) -> WikiGraphInsightsReceipt {
    let nodes = &graph.nodes;
    let node_map = nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let max_degree = nodes
        .iter()
        .map(|node| node.link_count)
        .max()
        .unwrap_or(1)
        .max(1);
    let mut surprising_connections = Vec::new();
    let mut neighbor_communities = BTreeMap::<&str, BTreeSet<usize>>::new();
    for edge in &graph.edges {
        let (Some(source), Some(target)) = (
            node_map.get(edge.from.as_str()),
            node_map.get(edge.to.as_str()),
        ) else {
            continue;
        };
        neighbor_communities
            .entry(&source.id)
            .or_default()
            .insert(target.community);
        neighbor_communities
            .entry(&target.id)
            .or_default()
            .insert(source.community);
        if structural(&source.id) || structural(&target.id) {
            continue;
        }
        let mut score = 0;
        let mut reasons = Vec::new();
        if source.community != target.community {
            score += 3;
            reasons.push("crosses community boundary".to_owned());
        }
        if source.kind != target.kind {
            if matches!(
                (source.kind.as_str(), target.kind.as_str()),
                ("source", "concept" | "synthesis")
                    | ("concept" | "synthesis", "source")
                    | ("query", "entity")
                    | ("entity", "query")
            ) {
                score += 2;
                reasons.push(format!("connects {} to {}", source.kind, target.kind));
            } else {
                score += 1;
                reasons.push("different types".to_owned());
            }
        }
        if source.link_count.min(target.link_count) <= 2
            && source.link_count.max(target.link_count) as f64 >= max_degree as f64 * 0.5
        {
            score += 2;
            reasons.push("peripheral node links to hub".to_owned());
        }
        if edge.weight > 0.0 && edge.weight < 2.0 {
            score += 1;
            reasons.push("weak but present connection".to_owned());
        }
        if score >= 3 {
            let mut ids = [source.id.as_str(), target.id.as_str()];
            ids.sort();
            surprising_connections.push(WikiSurprisingConnection {
                key: ids.join(":::"),
                source_id: source.id.clone(),
                target_id: target.id.clone(),
                score,
                reasons,
            });
        }
    }
    surprising_connections.sort_by_key(|connection| std::cmp::Reverse(connection.score));
    surprising_connections.truncate(5);
    let mut knowledge_gaps = Vec::new();
    let isolated = nodes
        .iter()
        .filter(|node| {
            node.link_count <= 1
                && node.kind != "overview"
                && node.id != "index"
                && node.id != "log"
        })
        .collect::<Vec<_>>();
    if !isolated.is_empty() {
        let mut description = isolated
            .iter()
            .take(5)
            .map(|node| node.label.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        if isolated.len() > 5 {
            description.push_str(&format!(" and {} more", isolated.len() - 5));
        }
        knowledge_gaps.push(gap(WikiKnowledgeGapType::IsolatedNode,
            format!("{} isolated page{}", isolated.len(), if isolated.len() > 1 { "s" } else { "" }), description,
            isolated.iter().map(|node| node.id.clone()).collect(),
            "These pages have few or no connections. Consider adding [[wikilinks]] to related pages, or research to expand their content."));
    }
    let mut community_members = BTreeMap::<usize, Vec<String>>::new();
    for node in nodes {
        community_members
            .entry(node.community)
            .or_default()
            .push(node.id.clone());
    }
    for community in &graph.communities {
        if community.cohesion < 0.15 && community.node_count >= 3 {
            knowledge_gaps.push(gap(WikiKnowledgeGapType::SparseCommunity,
                format!("Sparse cluster: {}", community.top_nodes.first().cloned().unwrap_or_else(|| format!("Community {}", community.id))),
                format!("{} pages with cohesion {:.2} — internal connections are weak.", community.node_count, community.cohesion),
                community_members.remove(&community.id).unwrap_or_default(),
                "This knowledge area lacks internal cross-references. Consider adding links between these pages or researching to fill gaps."));
        }
    }
    let mut bridges = nodes
        .iter()
        .filter(|node| {
            !structural(&node.id)
                && neighbor_communities
                    .get(node.id.as_str())
                    .is_some_and(|communities| communities.len() >= 3)
        })
        .collect::<Vec<_>>();
    bridges.sort_by_key(|node| std::cmp::Reverse(neighbor_communities[node.id.as_str()].len()));
    for bridge in bridges.into_iter().take(3) {
        knowledge_gaps.push(gap(WikiKnowledgeGapType::BridgeNode, format!("Key bridge: {}", bridge.label),
            format!("Connects {} different knowledge clusters. This is a critical junction in your wiki.", neighbor_communities[bridge.id.as_str()].len()),
            vec![bridge.id.clone()],
            "This page bridges multiple knowledge areas. Ensure it's well-maintained — if it's thin, expanding it will strengthen your entire wiki."));
    }
    knowledge_gaps.truncate(8);
    WikiGraphInsightsReceipt {
        project_id: project_id.to_owned(),
        surprising_connections,
        knowledge_gaps,
        dismissed_keys: BTreeSet::new(),
    }
}

fn structural(id: &str) -> bool {
    matches!(id, "index" | "log" | "overview")
}

fn gap(
    r#type: WikiKnowledgeGapType,
    title: String,
    description: String,
    node_ids: Vec<String>,
    suggestion: &str,
) -> WikiKnowledgeGap {
    let key = format!("gap:{}:{}:{}", r#type.as_str(), title, node_ids.join(","));
    WikiKnowledgeGap {
        key,
        r#type,
        title,
        description,
        node_ids,
        suggestion: suggestion.to_owned(),
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DismissedInsights {
    dismissed_keys: BTreeSet<String>,
}

pub(crate) fn read_dismissed(root: &Path) -> Result<BTreeSet<String>, WikiFailure> {
    Ok(crate::owner::actor::read_json::<DismissedInsights>(
        root.join(".llm-wiki/graph-insights.json"),
    )?
    .dismissed_keys)
}

pub(crate) fn dismiss(root: &Path, key: &str) -> Result<(), WikiFailure> {
    let mut dismissed_keys = read_dismissed(root)?;
    if dismissed_keys.insert(key.to_owned()) {
        crate::owner::actor::write_json(
            root.join(".llm-wiki/graph-insights.json"),
            &DismissedInsights { dismissed_keys },
        )?;
    }
    Ok(())
}
