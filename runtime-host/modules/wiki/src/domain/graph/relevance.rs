use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use super::{WikiGraphEdge, WikiGraphNode, page_stem, wiki_links};
use crate::domain::{SearchPage, WikiFailure, extract_search_title, normalize_relative_path};

pub(super) fn load_pages(root: &Path) -> Result<Vec<SearchPage>, WikiFailure> {
    fn visit(
        root: &Path,
        directory: &Path,
        pages: &mut Vec<SearchPage>,
    ) -> Result<(), WikiFailure> {
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(WikiFailure::io(directory.to_string_lossy(), error)),
        };
        let mut entries = entries
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| WikiFailure::io(directory.to_string_lossy(), error))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let kind = entry
                .file_type()
                .map_err(|error| WikiFailure::io(path.to_string_lossy(), error))?;
            if kind.is_dir() {
                visit(root, &path, pages)?;
            } else if kind.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("md")
            {
                let Ok(content) = std::fs::read_to_string(&path) else {
                    continue;
                };
                pages.push(SearchPage {
                    relative_path: normalize_relative_path(
                        path.strip_prefix(root).expect("wiki descendant"),
                    ),
                    title: extract_search_title(&content, &entry.file_name().to_string_lossy()),
                    content,
                });
            }
        }
        Ok(())
    }
    let mut pages = Vec::new();
    visit(root, &root.join("wiki"), &mut pages)?;
    Ok(pages)
}

struct Page {
    node: WikiGraphNode,
    sources: Vec<String>,
    retrieval_kind: String,
    links: Vec<String>,
}

pub(super) fn build(pages: Vec<SearchPage>) -> (Vec<WikiGraphNode>, Vec<WikiGraphEdge>) {
    let mut parsed = Vec::<Page>::new();
    let mut positions = BTreeMap::new();
    for page in pages {
        let id = page_stem(&page.relative_path);
        let frontmatter = frontmatter(&page.content);
        let kind = frontmatter
            .get("type")
            .filter(|value| !value.is_sequence())
            .map(scalar)
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_lowercase())
            .unwrap_or_else(|| "other".to_owned());
        let label = frontmatter
            .get("title")
            .filter(|value| !value.is_sequence())
            .map(scalar)
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_owned())
            .unwrap_or_else(|| {
                page.content
                    .lines()
                    .find_map(|line| line.strip_prefix("# ").map(str::trim))
                    .map(str::to_owned)
                    .unwrap_or_else(|| id.replace('-', " "))
            });
        let (sources, retrieval_kind) = retrieval_metadata(&page.content);
        let record = Page {
            node: WikiGraphNode::new(id.clone(), label, kind, page.relative_path),
            sources,
            retrieval_kind,
            links: wiki_links(&page.content),
        };
        if let Some(&index) = positions.get(&id) {
            parsed[index] = record;
        } else {
            positions.insert(id, parsed.len());
            parsed.push(record);
        }
    }
    let exact_ids = parsed
        .iter()
        .enumerate()
        .map(|(index, page)| (page.node.id.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    let mut retrieval_aliases = BTreeMap::new();
    for (index, page) in parsed.iter().enumerate() {
        retrieval_aliases
            .entry(normalized_target(&page.node.id))
            .or_insert(index);
    }
    let visible_aliases = aliases(&parsed);
    let mut outgoing = vec![BTreeSet::new(); parsed.len()];
    let mut incoming = vec![BTreeSet::new(); parsed.len()];
    let mut degree = vec![0usize; parsed.len()];
    let mut edges = Vec::new();
    let mut seen = BTreeSet::new();
    for (source, page) in parsed.iter().enumerate() {
        for link in &page.links {
            let retrieval_target = exact_ids
                .get(link.as_str())
                .copied()
                .or_else(|| retrieval_aliases.get(&normalized_target(link)).copied());
            if let Some(target) = retrieval_target.filter(|target| *target != source) {
                outgoing[source].insert(target);
                incoming[target].insert(source);
            }
            if page.node.kind == "query" {
                continue;
            }
            let Some(target) = resolve(link, &visible_aliases).filter(|target| *target != source)
            else {
                continue;
            };
            degree[source] += 1;
            degree[target] += 1;
            if seen.insert((source.min(target), source.max(target))) {
                edges.push((source, target));
            }
        }
    }
    let neighbors = outgoing
        .iter()
        .zip(&incoming)
        .map(|(out, incoming)| out.union(incoming).copied().collect::<BTreeSet<_>>())
        .collect::<Vec<_>>();
    let source_sets = parsed
        .iter()
        .map(|page| page.sources.iter().collect::<BTreeSet<_>>())
        .collect::<Vec<_>>();
    let weighted = parsed
        .iter()
        .filter(|page| page.node.kind != "query")
        .count()
        <= 3_000;
    let edges = edges
        .into_iter()
        .map(|(source, target)| {
            let mut edge = WikiGraphEdge::new(
                parsed[source].node.id.clone(),
                parsed[target].node.id.clone(),
                "EXTRACTED".to_owned(),
            );
            if weighted {
                let direct = usize::from(outgoing[source].contains(&target))
                    + usize::from(outgoing[target].contains(&source));
                let shared_sources = parsed[target]
                    .sources
                    .iter()
                    .filter(|value| source_sets[source].contains(value))
                    .count();
                let adamic_adar: f64 = neighbors[source]
                    .intersection(&neighbors[target])
                    .map(|neighbor| {
                        1.0 / ((outgoing[*neighbor].len() + incoming[*neighbor].len()).max(2)
                            as f64)
                            .ln()
                    })
                    .sum();
                edge.weight = 3.0 * direct as f64
                    + 4.0 * shared_sources as f64
                    + 1.5 * adamic_adar
                    + type_affinity(
                        &parsed[source].retrieval_kind,
                        &parsed[target].retrieval_kind,
                    );
            }
            edge
        })
        .collect();
    let nodes = parsed
        .into_iter()
        .enumerate()
        .filter_map(|(index, mut page)| {
            if page.node.kind == "query" {
                return None;
            }
            page.node.link_count = degree[index];
            Some(page.node)
        })
        .collect();
    (nodes, edges)
}

fn frontmatter(content: &str) -> serde_yaml::Value {
    use crate::owner::source_lifecycle::{locate_frontmatter_block, repair_wikilink_lists};
    let Some((_, start, end, _)) = locate_frontmatter_block(content) else {
        return serde_yaml::Value::Null;
    };
    let payload = &content[start..end];
    serde_yaml::from_str(payload)
        .or_else(|_| serde_yaml::from_str(&repair_wikilink_lists(payload)))
        .unwrap_or(serde_yaml::Value::Null)
}

fn scalar(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::Null => String::new(),
        serde_yaml::Value::String(value) => value.clone(),
        serde_yaml::Value::Bool(value) => value.to_string(),
        serde_yaml::Value::Number(value) => value.to_string(),
        value => serde_json::to_string(value).unwrap_or_default(),
    }
}

// Relevance uses the original retrieval parser's strict top-of-file metadata,
// not the graph display parser's recovered YAML/type normalization.
fn retrieval_metadata(content: &str) -> (Vec<String>, String) {
    let Some(content) = content.strip_prefix("---\n") else {
        return (Vec::new(), "other".to_owned());
    };
    let Some((payload, _)) = content.split_once("\n---") else {
        return (Vec::new(), "other".to_owned());
    };
    let mut kind = "other".to_owned();
    let mut sources = Vec::new();
    let mut lines = payload.lines().peekable();
    while let Some(line) = lines.next() {
        if let Some(value) = line.strip_prefix("type:") {
            let value = value.trim().trim_matches(['\'', '"']);
            if !value.is_empty() {
                kind = value.to_lowercase();
            }
        }
        if let Some(value) = line.strip_prefix("sources:") {
            let value = value.trim();
            if let Some(value) = value
                .strip_prefix('[')
                .and_then(|value| value.split_once(']').map(|(value, _)| value))
            {
                sources.extend(
                    value
                        .split(',')
                        .map(|source| source.trim().trim_matches(['\'', '"']).to_owned())
                        .filter(|source| !source.is_empty()),
                );
            } else if value.is_empty() {
                while let Some(line) = lines.peek() {
                    if !line.starts_with(char::is_whitespace) {
                        break;
                    }
                    let Some(value) = line.trim_start().strip_prefix("- ") else {
                        break;
                    };
                    let value = value.trim().trim_matches(['\'', '"']);
                    if !value.is_empty() {
                        sources.push(value.to_owned());
                    }
                    lines.next();
                }
            }
        }
    }
    (sources, kind)
}

fn normalized_target(value: &str) -> String {
    value
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

fn aliases(pages: &[Page]) -> BTreeMap<String, usize> {
    let mut aliases = BTreeMap::new();
    for (index, page) in pages
        .iter()
        .enumerate()
        .filter(|(_, page)| page.node.kind != "query")
    {
        aliases.insert(page.node.id.clone(), index);
    }
    for (index, page) in pages
        .iter()
        .enumerate()
        .filter(|(_, page)| page.node.kind != "query")
    {
        let lower = page.node.id.to_lowercase();
        aliases.entry(lower.clone()).or_insert(index);
        aliases
            .entry(lower.split_whitespace().collect::<Vec<_>>().join("-"))
            .or_insert(index);
    }
    aliases
}

fn resolve(link: &str, aliases: &BTreeMap<String, usize>) -> Option<usize> {
    let lower = link.to_lowercase();
    [
        link,
        &lower,
        &lower.split_whitespace().collect::<Vec<_>>().join("-"),
    ]
    .into_iter()
    .find_map(|alias| aliases.get(alias).copied())
}

fn type_affinity(source: &str, target: &str) -> f64 {
    match (source, target) {
        ("entity", "concept") | ("concept", "entity" | "synthesis") | ("synthesis", "concept") => {
            1.2
        }
        ("entity" | "concept" | "synthesis", "entity" | "concept" | "synthesis") => {
            if source == target { 0.8 } else { 1.0 }
        }
        ("source" | "query", "source" | "query") => {
            if source == target {
                0.5
            } else {
                0.8
            }
        }
        ("entity", "query") | ("query", "entity") => 0.8,
        ("source", "entity" | "concept" | "synthesis")
        | ("entity" | "concept" | "synthesis", "source")
        | ("concept" | "synthesis", "query")
        | ("query", "concept" | "synthesis") => 1.0,
        _ => 0.5,
    }
}
