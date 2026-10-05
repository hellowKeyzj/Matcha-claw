use std::{collections::BTreeSet, path::Path};

use super::source_lifecycle::{
    clean_index_listing, normalize_wiki_ref_key, refresh_file_snapshot, strip_deleted_wikilinks,
    wiki_markdown_files,
};
use crate::{
    domain::{
        WikiDeletePageFailure, WikiDeletePageReceipt, WikiDeletePageStage, WikiFailure,
        WikiNavigation, WikiNavigationPage, WikiWriteReceipt, normalize_relative_path,
        stable_content_hash,
    },
    ingest::write::{parse_frontmatter_array, parse_frontmatter_scalar, write_frontmatter_array},
};

pub(super) fn navigation(root: &Path, project_id: &str) -> Result<WikiNavigation, WikiFailure> {
    let mut pages = Vec::new();
    for file in wiki_markdown_files(root)? {
        let name = file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if matches!(name, "index.md" | "log.md") {
            continue;
        }
        let path = normalize_relative_path(file.strip_prefix(root).unwrap());
        if path.split('/').any(|part| part.starts_with('.')) {
            continue;
        }
        // The shared walk validates the Wiki root and never follows directory or file symlinks.
        let content =
            std::fs::read_to_string(&file).map_err(|error| WikiFailure::io(&path, error))?;
        let fallback_title = name.trim_end_matches(".md").replace('-', " ");
        let mut title = parse_frontmatter_scalar(&content, "title")
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| fallback_title.clone());
        if title == fallback_title {
            if let Some(heading) = content.lines().find_map(|line| line.strip_prefix("# ")) {
                title = heading.trim().to_owned();
            }
        }
        let kind = parse_frontmatter_scalar(&content, "type")
            .map(|kind| kind.trim().to_lowercase())
            .filter(|kind| !kind.is_empty() && kind != "other")
            .unwrap_or_else(|| infer_type(&path));
        pages.push(WikiNavigationPage {
            path,
            title,
            kind,
            tags: parse_frontmatter_array(&content, "tags"),
            origin: parse_frontmatter_scalar(&content, "origin")
                .filter(|origin| !origin.is_empty()),
            sources: parse_frontmatter_array(&content, "sources"),
        });
    }
    pages.sort_by(|left, right| navigation_order(&left.path, &right.path));
    Ok(WikiNavigation {
        project_id: project_id.to_owned(),
        pages,
    })
}

fn navigation_order(left: &str, right: &str) -> std::cmp::Ordering {
    let mut left = left.split('/').peekable();
    let mut right = right.split('/').peekable();
    loop {
        match (left.next(), right.next()) {
            (Some(a), Some(b)) if a != b => {
                return right
                    .peek()
                    .is_some()
                    .cmp(&left.peek().is_some())
                    .then_with(|| a.cmp(b));
            }
            (Some(_), Some(_)) => {}
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (None, None) => return std::cmp::Ordering::Equal,
        }
    }
}

fn infer_type(path: &str) -> String {
    let normalized = path.to_lowercase();
    for (directory, kind) in [
        ("entities", "entity"),
        ("concepts", "concept"),
        ("sources", "source"),
        ("queries", "query"),
        ("comparisons", "comparison"),
        ("synthesis", "synthesis"),
        ("findings", "finding"),
        ("thesis", "thesis"),
        ("methodology", "methodology"),
    ] {
        if normalized.split('/').any(|part| part == directory) {
            return kind.to_owned();
        }
    }
    if normalized.ends_with("/overview.md") {
        return "overview".to_owned();
    }
    let parts = normalized.split('/').collect::<Vec<_>>();
    if parts.len() == 3 && !parts[1].starts_with('.') {
        parts[1].to_owned()
    } else {
        "other".to_owned()
    }
}

pub(super) async fn delete_page(
    root: &Path,
    project_id: &str,
    relative: &str,
    file_already_deleted: bool,
    mut write: impl FnMut(String, String) -> Result<WikiWriteReceipt, WikiFailure>,
) -> Result<WikiDeletePageReceipt, WikiFailure> {
    if !crate::ingest::parser::is_safe_ingest_path(relative) || relative.contains('\\') {
        return Err(WikiFailure::invalid_path(relative));
    }
    let page = super::lint::wiki_path(root, relative)?;
    let name = page
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if relative.starts_with("wiki/media/") || matches!(name, "index.md" | "log.md") {
        return Err(WikiFailure::invalid_path(relative));
    }
    let mut receipt = WikiDeletePageReceipt {
        project_id: project_id.to_owned(),
        path: relative.to_owned(),
        ..Default::default()
    };
    let content = match std::fs::read_to_string(&page) {
        Ok(content) => content,
        Err(error) if file_already_deleted && error.kind() == std::io::ErrorKind::NotFound => {
            String::new()
        }
        Err(error) => {
            failure(
                &mut receipt,
                WikiDeletePageStage::File,
                relative,
                WikiFailure::io(relative, error),
            );
            return Ok(receipt);
        }
    };
    let slug = page
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let mut keys = BTreeSet::from([normalize_wiki_ref_key(slug)]);
    if let Some(title) = parse_frontmatter_scalar(&content, "title") {
        keys.insert(normalize_wiki_ref_key(&title));
    }
    match std::fs::remove_file(&page) {
        Ok(()) => receipt.deleted_pages.push(relative.to_owned()),
        Err(error) if file_already_deleted && error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            failure(
                &mut receipt,
                WikiDeletePageStage::File,
                relative,
                WikiFailure::io(relative, error),
            );
            return Ok(receipt);
        }
    }
    if crate::vector::delete_page(root, &stable_content_hash(relative.as_bytes()))
        .await
        .is_err()
    {
        failure(
            &mut receipt,
            WikiDeletePageStage::Vector,
            relative,
            WikiFailure::state("Wiki page index cleanup failed"),
        );
    }
    if relative.starts_with("wiki/sources/") && !slug.is_empty() && !slug.starts_with('.') {
        let media_relative = format!("wiki/media/{slug}");
        let media = root.join(&media_relative);
        let removed = (|| -> Result<bool, WikiFailure> {
            let metadata = match std::fs::symlink_metadata(&media) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(WikiFailure::io(&media_relative, error)),
            };
            let canonical = media
                .canonicalize()
                .map_err(|error| WikiFailure::io(&media_relative, error))?;
            let wiki_root = root
                .join("wiki")
                .canonicalize()
                .map_err(|error| WikiFailure::io("wiki", error))?;
            let project_root = root
                .canonicalize()
                .map_err(|error| WikiFailure::io("project", error))?;
            if metadata.file_type().is_symlink()
                || !canonical.starts_with(wiki_root)
                || !canonical.starts_with(project_root)
            {
                return Err(WikiFailure::invalid_path(&media_relative));
            }
            std::fs::remove_dir_all(&media)
                .map_err(|error| WikiFailure::io(&media_relative, error))?;
            Ok(true)
        })();
        match removed {
            Ok(true) => receipt.deleted_media.push(media_relative),
            Ok(false) => {}
            Err(error) => failure(
                &mut receipt,
                WikiDeletePageStage::Media,
                &media_relative,
                error,
            ),
        }
    }
    match wiki_markdown_files(root) {
        Ok(files) => {
            for file in files {
                let path = normalize_relative_path(file.strip_prefix(root).unwrap());
                if let Err(error) = super::lint::wiki_path(root, &path) {
                    failure(&mut receipt, WikiDeletePageStage::References, &path, error);
                    continue;
                }
                let content = match std::fs::read_to_string(&file) {
                    Ok(content) => content,
                    Err(error) => {
                        failure(
                            &mut receipt,
                            WikiDeletePageStage::References,
                            &path,
                            WikiFailure::io(&path, error),
                        );
                        continue;
                    }
                };
                let mut updated =
                    if file.file_name().and_then(|name| name.to_str()) == Some("index.md") {
                        clean_index_listing(&content, &keys)
                    } else {
                        content.clone()
                    };
                updated = strip_deleted_wikilinks(&updated, &keys);
                let related = parse_frontmatter_array(&updated, "related");
                let survivors = related
                    .iter()
                    .filter(|reference| !keys.contains(&normalize_wiki_ref_key(reference)))
                    .cloned()
                    .collect::<Vec<_>>();
                if survivors.len() != related.len() {
                    updated = write_frontmatter_array(&updated, "related", &survivors);
                }
                if updated != content {
                    match write(path.clone(), updated.clone()) {
                        Ok(_) => receipt.updated_pages.push(path),
                        Err(error) => {
                            // The existing writer can fail snapshot persistence after committing the file.
                            if std::fs::read_to_string(&file).is_ok_and(|actual| actual == updated)
                            {
                                receipt.updated_pages.push(path.clone());
                            }
                            failure(&mut receipt, WikiDeletePageStage::References, &path, error);
                        }
                    }
                }
            }
        }
        Err(error) => failure(&mut receipt, WikiDeletePageStage::References, "wiki", error),
    }
    let mut paths = vec![relative];
    paths.extend(receipt.updated_pages.iter().map(String::as_str));
    if let Err(error) = refresh_file_snapshot(root, &paths) {
        failure(
            &mut receipt,
            WikiDeletePageStage::Snapshot,
            ".llm-wiki/file-snapshot.json",
            error,
        );
    }
    Ok(receipt)
}

fn failure(
    receipt: &mut WikiDeletePageReceipt,
    stage: WikiDeletePageStage,
    path: &str,
    error: WikiFailure,
) {
    receipt.failures.push(WikiDeletePageFailure {
        stage,
        path: path.to_owned(),
        message: crate::lint::public_failure(&error),
    });
}
