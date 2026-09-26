use std::{collections::HashMap, path::Path};

use serde::{Deserialize, Serialize};

use super::{error::WikiFailure, path::normalize_relative_path};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphNode {
    id: String,
    label: String,
    kind: String,
    relative_path: String,
}

impl WikiGraphNode {
    pub fn new(id: String, label: String, kind: String, relative_path: String) -> Self {
        Self {
            id,
            label,
            kind,
            relative_path,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphEdge {
    from: String,
    to: String,
    confidence: String,
}

impl WikiGraphEdge {
    pub fn new(from: String, to: String, confidence: String) -> Self {
        Self {
            from,
            to,
            confidence,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphReceipt {
    nodes: Vec<WikiGraphNode>,
    edges: Vec<WikiGraphEdge>,
}

impl WikiGraphReceipt {
    pub fn new(nodes: Vec<WikiGraphNode>, edges: Vec<WikiGraphEdge>) -> Self {
        Self { nodes, edges }
    }
}

pub fn build_graph(root: &Path) -> Result<WikiGraphReceipt, WikiFailure> {
    let mut nodes = Vec::new();
    let mut bodies = HashMap::new();
    for (directory, kind) in graph_directories() {
        let base = root.join(directory);
        if !base.is_dir() {
            continue;
        }
        collect_nodes(root, &base, kind, &mut nodes, &mut bodies)?;
    }

    let ids = nodes
        .iter()
        .map(|node| (node.id.clone(), ()))
        .collect::<HashMap<_, _>>();
    let mut edges = Vec::new();
    for (from, content) in bodies {
        for target in wiki_links(&content) {
            if target != from && ids.contains_key(&target) {
                edges.push(WikiGraphEdge::new(
                    from.clone(),
                    target,
                    "EXTRACTED".to_owned(),
                ));
            }
        }
    }
    edges.sort_by(|left, right| {
        left.from
            .cmp(&right.from)
            .then_with(|| left.to.cmp(&right.to))
    });
    edges.dedup_by(|left, right| left.from == right.from && left.to == right.to);
    Ok(WikiGraphReceipt::new(nodes, edges))
}

fn graph_directories() -> [(&'static str, &'static str); 6] {
    [
        ("wiki/entities", "entity"),
        ("wiki/concepts", "concept"),
        ("wiki/sources", "source"),
        ("wiki/queries", "query"),
        ("wiki/comparisons", "comparison"),
        ("wiki/synthesis", "synthesis"),
    ]
}

fn collect_nodes(
    root: &Path,
    directory: &Path,
    kind: &str,
    nodes: &mut Vec<WikiGraphNode>,
    bodies: &mut HashMap<String, String>,
) -> Result<(), WikiFailure> {
    for entry in std::fs::read_dir(directory)
        .map_err(|error| WikiFailure::io(path_text(directory), error))?
    {
        let entry = entry.map_err(|error| WikiFailure::io(path_text(directory), error))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| WikiFailure::io(path_text(&path), error))?;
        if metadata.is_dir() {
            collect_nodes(root, &path, kind, nodes, bodies)?;
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            continue;
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|error| WikiFailure::io(path_text(&path), error))?;
        let id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_owned();
        if id.is_empty() {
            continue;
        }
        let label = first_heading(&content).unwrap_or_else(|| id.clone());
        let relative_path = path
            .strip_prefix(root)
            .map(normalize_relative_path)
            .unwrap_or_else(|_| path_text(&path));
        nodes.push(WikiGraphNode::new(
            id.clone(),
            label,
            kind.to_owned(),
            relative_path,
        ));
        bodies.insert(id, content);
    }
    nodes.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(())
}

fn first_heading(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        line.strip_prefix("# ")
            .map(str::trim)
            .filter(|heading| !heading.is_empty())
            .map(str::to_owned)
    })
}

fn wiki_links(content: &str) -> Vec<String> {
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

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
