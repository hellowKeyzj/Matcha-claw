use std::collections::BTreeSet;

use super::PageSummary;
use crate::{
    domain::{WikiReviewItem, WikiReviewType},
    owner::review_lifecycle::normalize_review_title,
};

pub(crate) fn resolved_by_rules(pending: &[WikiReviewItem], pages: &[PageSummary]) -> Vec<String> {
    let ids = pages
        .iter()
        .map(|page| page.id.as_str())
        .collect::<BTreeSet<_>>();
    let titles = pages
        .iter()
        .filter_map(|page| page.title.as_ref().map(|title| title.to_lowercase()))
        .collect::<BTreeSet<_>>();
    pending
        .iter()
        .filter(|review| {
            if review.resolved {
                return false;
            }
            match review.review_type {
                WikiReviewType::MissingPage => {
                    let title = normalize_review_title(&review.title);
                    (!title.is_empty()
                        && title.chars().count() <= 100
                        && page_exists(&title, &ids, &titles))
                        || review
                            .affected_pages
                            .iter()
                            .any(|path| page_exists(&basename(path), &ids, &titles))
                }
                WikiReviewType::Duplicate => review
                    .affected_pages
                    .iter()
                    .any(|path| !ids.contains(basename(path).as_str())),
                _ => false,
            }
        })
        .map(|review| review.id.clone())
        .collect()
}

fn basename(path: &str) -> String {
    let leaf = path.rsplit('/').next().unwrap_or(path);
    leaf.strip_suffix(".md").unwrap_or(leaf).to_lowercase()
}

fn page_exists(name: &str, ids: &BTreeSet<&str>, titles: &BTreeSet<String>) -> bool {
    let name = name.trim().to_lowercase();
    !name.is_empty()
        && (ids.contains(name.as_str())
            || titles.contains(&name)
            || ids.contains(
                name.split_whitespace()
                    .collect::<Vec<_>>()
                    .join("-")
                    .as_str(),
            ))
}
