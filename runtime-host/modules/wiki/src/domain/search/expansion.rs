use std::collections::{BTreeMap, BTreeSet};

use super::super::{
    graph::{normalize_graph_alias, page_aliases, wiki_links},
    model::WikiSearchHit,
};
use super::{SearchPage, extract_search_images};

pub(super) fn blend_graph_results(
    ranked_hits: &mut Vec<WikiSearchHit>,
    pages: &[SearchPage],
    limit: usize,
    vector_hits: usize,
    include_content: bool,
) -> usize {
    if ranked_hits.is_empty() || pages.is_empty() {
        ranked_hits.truncate(limit);
        return 0;
    }
    let pages = pages
        .iter()
        .map(|page| (page.relative_path.replace('\\', "/"), page))
        .collect::<BTreeMap<_, _>>();
    let aliases = page_aliases(&pages);
    let mut adjacency = BTreeMap::<&str, BTreeSet<&str>>::new();
    for (source, page) in &pages {
        for link in wiki_links(&page.content) {
            let Some(target) = aliases.get(&normalize_graph_alias(&link)) else {
                continue;
            };
            if source == target {
                continue;
            }
            adjacency.entry(source).or_default().insert(target);
            adjacency.entry(target).or_default().insert(source);
        }
    }
    let seed_paths = ranked_hits
        .iter()
        .take(limit.min(20))
        .map(|hit| hit.relative_path.replace('\\', "/"))
        .collect::<Vec<_>>();
    let seed_set = seed_paths
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut candidate_scores = BTreeMap::<&str, f64>::new();
    let mut candidate_seeds = BTreeMap::<&str, BTreeSet<&str>>::new();
    for (rank, seed) in seed_paths.iter().enumerate() {
        let Some(neighbors) = adjacency.get(seed.as_str()) else {
            continue;
        };
        for neighbor in neighbors {
            if seed_set.contains(neighbor) {
                continue;
            }
            *candidate_scores.entry(neighbor).or_default() += 1.0 / (rank + 1) as f64;
            if let Some(seed_page) = pages.get(seed) {
                candidate_seeds
                    .entry(neighbor)
                    .or_default()
                    .insert(&seed_page.title);
            }
        }
    }
    let mut candidates = candidate_scores.into_iter().collect::<Vec<_>>();
    candidates.sort_by(|(path_a, score_a), (path_b, score_b)| {
        score_b
            .partial_cmp(score_a)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| path_a.cmp(path_b))
    });
    candidates.truncate(graph_result_quota(limit, vector_hits));
    if candidates.is_empty() {
        ranked_hits.truncate(limit);
        return 0;
    }
    let selected_paths = candidates
        .iter()
        .map(|(path, _)| *path)
        .collect::<BTreeSet<_>>();
    let graph_count = candidates.len();
    let mut graph_existing = BTreeMap::new();
    let mut results = Vec::new();
    for hit in ranked_hits.drain(..) {
        let path = hit.relative_path.replace('\\', "/");
        if selected_paths.contains(path.as_str()) {
            graph_existing.insert(path, hit);
        } else if results.len() < limit.saturating_sub(graph_count) {
            results.push(hit);
        }
    }
    for (path, graph_score) in candidates {
        let related_titles = candidate_seeds
            .remove(path)
            .unwrap_or_default()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if let Some(mut hit) = graph_existing.remove(path) {
            hit.graph_related_to = related_titles;
            results.push(hit);
            continue;
        }
        let Some(page) = pages.get(path) else {
            continue;
        };
        let mut hit = WikiSearchHit::new(
            page.relative_path.clone(),
            page.title.clone(),
            graph_score / 61.0,
            vec![format!("Graph neighbor of {}", related_titles.join(", "))],
        );
        hit.images = extract_search_images(&page.content);
        hit.content = include_content.then(|| page.content.clone());
        hit.graph_related_to = related_titles;
        results.push(hit);
    }
    *ranked_hits = results;
    graph_count
}

fn graph_result_quota(limit: usize, vector_hits: usize) -> usize {
    if limit < 2 {
        return 0;
    }
    let vector_coverage = vector_hits.min(limit) as f64 / limit as f64;
    let ratio = 0.30 - (0.30 - 0.15) * vector_coverage;
    ((limit as f64 * ratio).ceil() as usize).clamp(1, limit - 1)
}
