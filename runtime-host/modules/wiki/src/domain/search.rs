use std::path::Path;

use super::{
    error::WikiFailure,
    model::{WikiSearchHit, WikiSearchReceipt},
    path::normalize_relative_path,
};

mod document;
mod expansion;
mod lexical;

pub use document::{extract_search_images, extract_search_title, search_snippet};

const MAX_SEARCH_FILES: usize = 10_000;
const MAX_RESULTS: usize = 50;

#[derive(Clone, Debug)]
pub struct SearchPage {
    pub relative_path: String,
    pub title: String,
    pub content: String,
}

pub fn load_search_pages(root: &Path) -> Result<Vec<SearchPage>, WikiFailure> {
    let mut pages = Vec::new();
    let mut searched_files = 0;
    collect_pages(root, &root.join("wiki"), &mut searched_files, &mut pages);
    Ok(pages)
}

pub fn keyword_hits(
    pages: &[SearchPage],
    query: &str,
    include_content: bool,
) -> Result<Vec<WikiSearchHit>, WikiFailure> {
    if query.trim().is_empty() {
        return Err(WikiFailure::invalid_input("query", "query is required"));
    }
    let mut tokens = lexical::tokenize_query(query);
    if tokens.is_empty() {
        tokens.push(query.trim().to_lowercase());
    }
    let phrase = lexical::query_phrase(query);
    let mut hits = pages
        .iter()
        .filter_map(|page| lexical::score_page(page, &tokens, &phrase, query, include_content))
        .collect::<Vec<_>>();
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    Ok(hits)
}

pub fn finish_search(
    pages: &[SearchPage],
    query: &str,
    mut ranked_hits: Vec<WikiSearchHit>,
    limit: usize,
    token_hits: usize,
    vector_hits: usize,
    include_content: bool,
) -> WikiSearchReceipt {
    let graph_hits = expansion::blend_graph_results(
        &mut ranked_hits,
        pages,
        limit.clamp(1, MAX_RESULTS),
        vector_hits,
        include_content,
    );
    let mut receipt = WikiSearchReceipt::new(query.to_owned(), ranked_hits);
    receipt.mode = if graph_hits > 0 {
        "hybrid"
    } else if vector_hits == 0 {
        "keyword"
    } else if token_hits == 0 {
        "vector"
    } else {
        "hybrid"
    }
    .to_owned();
    receipt.token_hits = token_hits;
    receipt.vector_hits = vector_hits;
    receipt.graph_hits = graph_hits;
    receipt
}

fn collect_pages(
    root: &Path,
    directory: &Path,
    searched_files: &mut usize,
    pages: &mut Vec<SearchPage>,
) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        if *searched_files >= MAX_SEARCH_FILES {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            collect_pages(root, &path, searched_files, pages);
            continue;
        }
        if !file_type.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("md")
        {
            continue;
        }
        *searched_files += 1;
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        pages.push(SearchPage {
            relative_path: path
                .strip_prefix(root)
                .map(normalize_relative_path)
                .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/")),
            title: extract_search_title(&content, file_name),
            content,
        });
    }
}
