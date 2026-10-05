use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use crate::{
    domain::{WikiDedupTask, WikiFailure},
    ingest::write::{
        merge_array_fields_into_content, parse_frontmatter_array, set_frontmatter_scalar,
        write_frontmatter_array,
    },
    ports::WikiIngestLlm,
};
use tokio_util::sync::CancellationToken;

use super::{Page, call_llm, prompts};

pub(crate) async fn compute_merge(
    pages: &[Page],
    task: &WikiDedupTask,
    llm: &Arc<dyn WikiIngestLlm>,
    model_ref: Option<String>,
    cancellation: &CancellationToken,
) -> Result<(Page, Vec<Page>, Vec<String>, Vec<Page>), WikiFailure> {
    let mut group = Vec::new();
    for slug in &task.group.slugs {
        let matches = pages
            .iter()
            .filter(|page| {
                std::path::Path::new(&page.path)
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    == Some(slug)
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [page]
                if page.path.starts_with("wiki/entities/")
                    || page.path.starts_with("wiki/concepts/") =>
            {
                group.push(*page)
            }
            [_] => {
                return Err(WikiFailure::invalid_input(
                    "group.slugs",
                    "Only entity and concept pages participate in duplicate merging",
                ));
            }
            [] => {
                return Err(WikiFailure::invalid_input(
                    "group.slugs",
                    format!("Page {slug} was removed since detection; scan again"),
                ));
            }
            _ => {
                return Err(WikiFailure::invalid_input(
                    "group.slugs",
                    format!("Slug {slug} is ambiguous across wiki folders"),
                ));
            }
        }
    }
    let canonical = group
        .iter()
        .find(|page| {
            std::path::Path::new(&page.path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                == Some(task.canonical_slug.as_str())
        })
        .ok_or_else(|| {
            WikiFailure::invalid_input("canonicalSlug", "canonical page is not in the group")
        })?;
    let sections = group
        .iter()
        .zip(&task.group.slugs)
        .enumerate()
        .map(|(index, (page, slug))| {
            format!("## Page {} (slug: {slug})\n\n{}\n", index + 1, page.content)
        })
        .collect::<Vec<_>>()
        .join("\n---\n\n");
    let user = format!(
        "These {} wiki pages have been confirmed by the user to describe the same topic.\nMerge them into a single coherent page (the canonical slug will be \"{}\" or whichever the caller chose).\n\n{sections}\n\nNow output the merged file. First character must be `-`.",
        group.len(),
        task.group.slugs[0]
    );
    let mut content = call_llm(llm, model_ref, prompts::MERGER, user, 16384, cancellation).await?;
    // A full file is the write boundary: malformed/truncated output must not destroy canonical content.
    let normalized = content.replace("\r\n", "\n");
    let frontmatter = normalized
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---"));
    if frontmatter.is_none_or(|(yaml, body)| {
        serde_yaml::from_str::<serde_yaml::Value>(yaml).is_err() || body.trim().is_empty()
    }) {
        return Err(WikiFailure::state(
            "dedup merge did not return a complete frontmatter + body page; no files written",
        ));
    }
    for page in &group {
        content = merge_array_fields_into_content(
            &content,
            Some(&page.content),
            &["sources", "tags", "related"],
        );
    }
    content = set_frontmatter_scalar(
        &content,
        "updated",
        &chrono::Utc::now().format("%Y-%m-%d").to_string(),
    );
    let redirects = task
        .group
        .slugs
        .iter()
        .filter(|slug| *slug != &task.canonical_slug)
        .map(|slug| (slug.clone(), task.canonical_slug.clone()))
        .collect::<BTreeMap<_, _>>();
    let removed = redirects.keys().cloned().collect::<BTreeSet<_>>();
    let group_paths = group
        .iter()
        .map(|page| page.path.as_str())
        .collect::<BTreeSet<_>>();
    let mut rewrites = Vec::new();
    let mut backup = group.iter().map(|page| (*page).clone()).collect::<Vec<_>>();
    for page in pages
        .iter()
        .filter(|page| !group_paths.contains(page.path.as_str()))
    {
        let rewritten = if page.path == "wiki/index.md" {
            rewrite_index(&page.content, &removed)
        } else {
            rewrite_references(&page.content, &redirects)
        };
        if rewritten != page.content {
            rewrites.push(Page {
                path: page.path.clone(),
                content: rewritten,
            });
            backup.push(page.clone());
        }
    }
    let deleted = group
        .iter()
        .filter(|page| page.path != canonical.path)
        .map(|page| page.path.clone())
        .collect();
    Ok((
        Page {
            path: canonical.path.clone(),
            content,
        },
        rewrites,
        deleted,
        backup,
    ))
}

fn rewrite_references(content: &str, redirects: &BTreeMap<String, String>) -> String {
    let mut rewritten = content.to_owned();
    for (old, new) in redirects {
        let pattern = regex::Regex::new(&format!(r"\[\[{}(\|[^\]]+)?\]\]", regex::escape(old)))
            .expect("escaped slug pattern");
        rewritten = pattern
            .replace_all(&rewritten, |captures: &regex::Captures<'_>| {
                format!(
                    "[[{new}{}]]",
                    captures.get(1).map_or("", |alias| alias.as_str())
                )
            })
            .into_owned();
    }
    let existing = parse_frontmatter_array(&rewritten, "related");
    let mut seen = BTreeSet::new();
    let related = existing
        .iter()
        .map(|slug| redirects.get(slug).unwrap_or(slug).clone())
        .filter(|slug| seen.insert(slug.to_lowercase()))
        .collect::<Vec<_>>();
    if related != existing {
        rewritten = write_frontmatter_array(&rewritten, "related", &related);
    }
    rewritten
}

pub(crate) fn rewrite_index(content: &str, removed: &BTreeSet<String>) -> String {
    let patterns = removed
        .iter()
        .map(|slug| {
            let escaped = regex::escape(slug);
            regex::Regex::new(&format!(
                r"\[\[{escaped}(\|[^\]]*)?\]\]|\(([^)]*/)?{escaped}\.md\)|\b{escaped}\.md\b"
            ))
            .expect("escaped slug pattern")
        })
        .collect::<Vec<_>>();
    content
        .split('\n')
        .filter(|line| !patterns.iter().any(|pattern| pattern.is_match(line)))
        .collect::<Vec<_>>()
        .join("\n")
}
