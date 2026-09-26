use std::{collections::BTreeSet, path::Path};

use crate::domain::{
    WikiFailure, WikiReviewClearResolvedInput, WikiReviewDismissInput, WikiReviewItem,
    WikiReviewOption, WikiReviewResolveInput, WikiReviewType, WikiReviewsReceipt, now_ms,
};

const REVIEW_FILE: &str = ".llm-wiki/review.json";

pub(super) fn reviews(root: &Path) -> WikiReviewsReceipt {
    WikiReviewsReceipt::new(read_review_items(root))
}

pub(super) fn append_review_items(
    root: &Path,
    incoming: Vec<WikiReviewItem>,
) -> Result<(), WikiFailure> {
    if incoming.is_empty() {
        return Ok(());
    }
    let mut items = read_review_items(root);
    items.extend(incoming);
    write_review_items(root, normalize_review_items(items))
}

pub(super) fn resolve_review(
    root: &Path,
    input: WikiReviewResolveInput,
) -> Result<WikiReviewsReceipt, WikiFailure> {
    let mut items = read_review_items(root);
    if let Some(item) = items.iter_mut().find(|item| item.id == input.id) {
        item.resolved = true;
        item.resolved_action = Some(input.action);
    }
    let items = normalize_review_items(items);
    write_review_items(root, items.clone())?;
    Ok(WikiReviewsReceipt::new(items))
}

pub(super) fn dismiss_review(
    root: &Path,
    input: WikiReviewDismissInput,
) -> Result<WikiReviewsReceipt, WikiFailure> {
    let items = read_review_items(root)
        .into_iter()
        .filter(|item| item.id != input.id)
        .collect::<Vec<_>>();
    write_review_items(root, items.clone())?;
    Ok(WikiReviewsReceipt::new(items))
}

pub(super) fn clear_resolved_reviews(
    root: &Path,
    _input: WikiReviewClearResolvedInput,
) -> Result<WikiReviewsReceipt, WikiFailure> {
    let items = read_review_items(root)
        .into_iter()
        .filter(|item| !item.resolved)
        .collect::<Vec<_>>();
    write_review_items(root, items.clone())?;
    Ok(WikiReviewsReceipt::new(items))
}

fn read_review_items(root: &Path) -> Vec<WikiReviewItem> {
    std::fs::read_to_string(root.join(REVIEW_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<WikiReviewItem>>(&raw).ok())
        .map(normalize_review_items)
        .unwrap_or_default()
}

fn write_review_items(root: &Path, items: Vec<WikiReviewItem>) -> Result<(), WikiFailure> {
    let path = root.join(REVIEW_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    let raw = serde_json::to_string_pretty(&items)
        .map_err(|error| WikiFailure::state(format!("review encode failed: {error}")))?;
    std::fs::write(&path, raw).map_err(|error| WikiFailure::io(path_text(&path), error))
}

fn normalize_review_items(items: Vec<WikiReviewItem>) -> Vec<WikiReviewItem> {
    let mut merged = Vec::<WikiReviewItem>::new();
    for mut item in items {
        item.id = review_id_for(item.review_type, &item.title);
        if item.created_at == 0 {
            item.created_at = now_ms();
        }
        normalize_review_item_lists(&mut item);
        if let Some(existing) = merged.iter_mut().find(|existing| existing.id == item.id) {
            merge_review_item(existing, item);
        } else {
            merged.push(item);
        }
    }
    merged.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(left.id.cmp(&right.id))
    });
    merged
}

fn merge_review_item(existing: &mut WikiReviewItem, incoming: WikiReviewItem) {
    if !incoming.description.trim().is_empty() {
        existing.description = incoming.description;
    }
    if incoming
        .source_path
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        existing.source_path = incoming.source_path;
    }
    extend_unique(&mut existing.affected_pages, incoming.affected_pages);
    extend_unique(&mut existing.search_queries, incoming.search_queries);
    merge_options(&mut existing.options, incoming.options);
    existing.resolved = existing.resolved || incoming.resolved;
    if existing.resolved_action.is_none() {
        existing.resolved_action = incoming.resolved_action;
    }
    existing.created_at = existing.created_at.min(incoming.created_at);
}

fn normalize_review_item_lists(item: &mut WikiReviewItem) {
    dedupe_strings(&mut item.affected_pages);
    dedupe_strings(&mut item.search_queries);
    merge_options(&mut item.options, Vec::new());
}

fn extend_unique(target: &mut Vec<String>, source: Vec<String>) {
    target.extend(source);
    dedupe_strings(target);
}

fn dedupe_strings(values: &mut Vec<String>) {
    let mut seen = BTreeSet::<String>::new();
    values.retain(|value| {
        let trimmed = value.trim();
        !trimmed.is_empty() && seen.insert(trimmed.to_owned())
    });
    for value in values {
        *value = value.trim().to_owned();
    }
}

fn merge_options(target: &mut Vec<WikiReviewOption>, source: Vec<WikiReviewOption>) {
    target.extend(source);
    let mut seen = BTreeSet::<String>::new();
    target.retain(|option| {
        let action = option.action.trim();
        !action.is_empty() && seen.insert(action.to_owned())
    });
    for option in target {
        option.label = option.label.trim().to_owned();
        option.action = option.action.trim().to_owned();
    }
}

fn review_id_for(review_type: WikiReviewType, title: &str) -> String {
    let key = format!(
        "{}::{}",
        review_type_key(review_type),
        normalize_review_title(title)
    );
    let mut hash = 0x811c9dc5_u32;
    for code_unit in key.encode_utf16() {
        hash ^= u32::from(code_unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("review-{hash:08x}")
}

fn normalize_review_title(title: &str) -> String {
    let mut value = title.trim_start();
    let lower = value.to_lowercase();
    for prefix in [
        "missing page:",
        "missing page：",
        "missing-page:",
        "missing-page：",
        "missingpage:",
        "missingpage：",
        "duplicate page:",
        "duplicate page：",
        "duplicate-page:",
        "duplicate-page：",
        "duplicatepage:",
        "duplicatepage：",
        "possible duplicate:",
        "possible duplicate：",
        "possible-duplicate:",
        "possible-duplicate：",
        "possibleduplicate:",
        "possibleduplicate：",
        "缺失页面:",
        "缺失页面：",
        "缺少页面:",
        "缺少页面：",
        "重复页面:",
        "重复页面：",
        "疑似重复:",
        "疑似重复：",
    ] {
        if lower.starts_with(prefix) {
            value = value[prefix.len()..].trim_start();
            break;
        }
    }
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn review_type_key(review_type: WikiReviewType) -> &'static str {
    match review_type {
        WikiReviewType::Contradiction => "contradiction",
        WikiReviewType::Duplicate => "duplicate",
        WikiReviewType::MissingPage => "missing-page",
        WikiReviewType::Confirm => "confirm",
        WikiReviewType::Suggestion => "suggestion",
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
