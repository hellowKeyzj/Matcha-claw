use std::collections::BTreeSet;

use super::super::model::WikiSearchImage;

const SNIPPET_CONTEXT: usize = 80;

pub fn extract_search_title(content: &str, file_name: &str) -> String {
    let has_frontmatter = content.starts_with("---");
    let mut in_frontmatter = has_frontmatter;
    let mut frontmatter_closed = false;
    for line in content.lines().skip(usize::from(has_frontmatter)) {
        let trimmed = line.trim();
        if in_frontmatter && trimmed == "---" {
            in_frontmatter = false;
            frontmatter_closed = true;
            continue;
        }
        if in_frontmatter && trimmed.starts_with("title:") {
            return trimmed
                .trim_start_matches("title:")
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_owned();
        }
        if has_frontmatter && !frontmatter_closed {
            continue;
        }
        if let Some(title) = trimmed.strip_prefix("# ") {
            return title.trim().to_owned();
        }
    }
    file_name.trim_end_matches(".md").replace('-', " ")
}

pub fn extract_search_images(content: &str) -> Vec<WikiSearchImage> {
    let mut images = Vec::new();
    let mut seen = BTreeSet::new();
    let mut rest = content;
    while let Some(start) = rest.find("![") {
        rest = &rest[start + 2..];
        let Some(alt_end) = rest.find("](") else {
            break;
        };
        let alt = &rest[..alt_end];
        rest = &rest[alt_end + 2..];
        let Some(url_end) = rest.find(')') else {
            break;
        };
        let url = &rest[..url_end];
        if !url.trim().is_empty()
            && !url.contains(char::is_whitespace)
            && seen.insert(url.to_owned())
        {
            images.push(WikiSearchImage {
                url: url.to_owned(),
                alt: alt.to_owned(),
            });
        }
        rest = &rest[url_end + 1..];
    }
    images
}

pub fn search_snippet(content: &str, anchor: &str) -> String {
    let lower = content.to_lowercase();
    let anchor_lower = anchor.to_lowercase();
    let index = lower.find(&anchor_lower).unwrap_or(0);
    let char_positions = content
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if char_positions.is_empty() {
        return String::new();
    }
    let match_char = char_positions
        .iter()
        .position(|byte| *byte >= index)
        .unwrap_or(char_positions.len().saturating_sub(1));
    let anchor_chars = anchor.chars().count().max(1);
    let start_char = match_char.saturating_sub(SNIPPET_CONTEXT);
    let end_char = (match_char + anchor_chars + SNIPPET_CONTEXT).min(char_positions.len());
    let start = char_positions[start_char];
    let end = char_positions
        .get(end_char)
        .copied()
        .unwrap_or(content.len());
    let mut snippet = content[start..end].replace('\n', " ");
    if start > 0 {
        snippet = format!("...{snippet}");
    }
    if end < content.len() {
        snippet.push_str("...");
    }
    snippet
}
