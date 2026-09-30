mod community;
mod relevance;

use std::{collections::BTreeMap, path::Path};

use serde::{Deserialize, Serialize};

use super::{error::WikiFailure, search::SearchPage};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphNode {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) kind: String,
    relative_path: String,
    pub(crate) link_count: usize,
    pub(crate) community: usize,
}

impl WikiGraphNode {
    pub fn new(id: String, label: String, kind: String, relative_path: String) -> Self {
        Self {
            id,
            label,
            kind,
            relative_path,
            link_count: 0,
            community: 0,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphEdge {
    pub(crate) from: String,
    pub(crate) to: String,
    confidence: String,
    pub(crate) weight: f64,
}

impl WikiGraphEdge {
    pub fn new(from: String, to: String, confidence: String) -> Self {
        Self {
            from,
            to,
            confidence,
            weight: 1.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphCommunity {
    pub id: usize,
    pub node_count: usize,
    pub cohesion: f64,
    pub top_nodes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphReceipt {
    pub(crate) nodes: Vec<WikiGraphNode>,
    pub(crate) edges: Vec<WikiGraphEdge>,
    pub(crate) communities: Vec<WikiGraphCommunity>,
}

impl WikiGraphReceipt {
    pub fn new(nodes: Vec<WikiGraphNode>, edges: Vec<WikiGraphEdge>) -> Self {
        let mut graph = Self {
            nodes,
            edges,
            communities: Vec::new(),
        };
        community::assign(&mut graph);
        graph
    }
}

pub fn build_graph(root: &Path) -> Result<WikiGraphReceipt, WikiFailure> {
    let pages = relevance::load_pages(root)?;
    let graph = relevance::build(pages);
    Ok(WikiGraphReceipt::new(graph.0, graph.1))
}

// Search expansion retains its path/title aliases, independent of graph stem identity.
pub(super) fn page_aliases(pages: &BTreeMap<String, &SearchPage>) -> BTreeMap<String, String> {
    let mut aliases = BTreeMap::new();
    for (normalized_path, page) in pages {
        let wiki_relative = page
            .relative_path
            .strip_prefix("wiki/")
            .unwrap_or(&page.relative_path);
        let stem = page_stem(&page.relative_path);
        for alias in [
            page.relative_path.as_str(),
            wiki_relative,
            stem.as_str(),
            page.title.as_str(),
        ] {
            aliases.insert(normalize_graph_alias(alias), normalized_path.clone());
        }
    }
    aliases
}

pub(super) fn normalize_graph_alias(value: &str) -> String {
    value
        .split('#')
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches(".md")
        .replace('\\', "/")
        .replace(' ', "-")
        .to_lowercase()
}

fn page_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("")
        .to_owned()
}

pub(super) fn wiki_links(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find("]]") else {
            break;
        };
        let target = after_start[..end]
            .split('|')
            .next()
            .unwrap_or_default()
            .trim();
        if !target.is_empty() {
            links.push(target.to_owned());
        }
        rest = &after_start[end + 2..];
    }
    links
}
