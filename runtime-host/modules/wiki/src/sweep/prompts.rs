use super::PageSummary;
use crate::domain::{WikiReviewItem, WikiReviewType};

pub(super) fn build(pages: &[PageSummary], batch: &[WikiReviewItem]) -> String {
    let page_list = pages
        .iter()
        .take(300)
        .map(|page| match &page.title {
            Some(title) => format!("- {}  (title: {title})", page.id),
            None => format!("- {}", page.id),
        })
        .collect::<Vec<_>>()
        .join("\n");
    let review_list = batch
        .iter()
        .map(|review| {
            let affected = if review.affected_pages.is_empty() {
                String::new()
            } else {
                format!(" | affected: {}", review.affected_pages.join(", "))
            };
            let description = if review.description.is_empty() {
                String::new()
            } else {
                format!(
                    " — {}",
                    review.description.chars().take(200).collect::<String>()
                )
            };
            let kind = match review.review_type {
                WikiReviewType::Contradiction => "contradiction",
                WikiReviewType::Duplicate => "duplicate",
                WikiReviewType::MissingPage => "missing-page",
                WikiReviewType::Confirm => "confirm",
                WikiReviewType::Suggestion => "suggestion",
            };
            format!(
                "- id={} [{kind}] \"{}\"{description}{affected}",
                review.id, review.title
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    [
        "You are cleaning up a stale review queue for a personal wiki.",
        "After recent ingests, some review items may no longer be valid because the missing page now exists, the duplicate was resolved, or the referenced concept has been added.",
        "",
        "Current wiki pages (filename, optional title):",
        if page_list.is_empty() { "(no pages yet)" } else { &page_list },
        "",
        "Pending review items to judge:",
        &review_list,
        "",
        "For each review item, decide whether the underlying condition has been RESOLVED by the current wiki state.",
        "Be conservative: only mark as resolved if you are confident the concern no longer applies.",
        "For contradictions, confirmations, or human-judgment items, default to keeping them pending.",
        "",
        "Respond with ONLY a JSON object in this exact shape: {\"resolved\": [\"id1\", \"id2\"]}",
        "If none of the items are resolved, return exactly: {\"resolved\": []}",
        "Do not wrap in markdown fences. Do not add commentary.",
    ].join("\n")
}
