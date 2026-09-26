use std::path::Path;

use super::{
    error::WikiFailure,
    model::{WikiSearchHit, WikiSearchReceipt},
    path::normalize_relative_path,
};

pub fn keyword_search(
    root: &Path,
    query: &str,
    limit: usize,
) -> Result<WikiSearchReceipt, WikiFailure> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return Err(WikiFailure::invalid_input("query", "query is empty"));
    }
    let mut hits = Vec::new();
    collect_hits(root, &root.join("wiki"), &terms, &mut hits)?;
    hits.sort_by(|left, right| {
        right
            .score()
            .cmp(&left.score())
            .then_with(|| left.relative_path().cmp(right.relative_path()))
    });
    hits.truncate(limit.max(1));
    Ok(WikiSearchReceipt::new(query.to_owned(), hits))
}

fn collect_hits(
    root: &Path,
    directory: &Path,
    terms: &[String],
    hits: &mut Vec<WikiSearchHit>,
) -> Result<(), WikiFailure> {
    if !directory.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(directory)
        .map_err(|error| WikiFailure::io(path_text(directory), error))?
    {
        let entry = entry.map_err(|error| WikiFailure::io(path_text(directory), error))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| WikiFailure::io(path_text(&path), error))?;
        if metadata.is_dir() {
            collect_hits(root, &path, terms, hits)?;
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            continue;
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|error| WikiFailure::io(path_text(&path), error))?;
        let lower = content.to_lowercase();
        let score = terms
            .iter()
            .map(|term| lower.matches(term).count())
            .sum::<usize>();
        if score == 0 {
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map(normalize_relative_path)
            .unwrap_or_else(|_| path_text(&path));
        hits.push(WikiSearchHit::new(
            relative_path,
            title(&content, &path),
            score,
            snippets(&content, terms),
        ));
    }
    Ok(())
}

fn query_terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|term| term.trim().to_lowercase())
        .filter(|term| !term.is_empty())
        .collect()
}

fn title(content: &str, path: &Path) -> String {
    content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|heading| !heading.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

fn snippets(content: &str, terms: &[String]) -> Vec<String> {
    let mut snippets = Vec::new();
    for line in content.lines() {
        let lower = line.to_lowercase();
        if terms.iter().any(|term| lower.contains(term)) {
            snippets.push(line.trim().chars().take(240).collect());
            if snippets.len() == 3 {
                break;
            }
        }
    }
    snippets
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
