use std::{collections::BTreeSet, sync::OnceLock};

use regex::Regex;
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

use super::{
    WikiLintFinding, WikiLintRunInput, WikiLintSeverity, WikiLintType,
    pages::{Page, basename, normalize_target, utf16_prefix},
};
use crate::{
    domain::WikiFailure,
    ports::{
        WikiIngestLlm, WikiIngestLlmMessage, WikiIngestLlmOptions, WikiIngestLlmRequest,
        WikiIngestLlmRole,
    },
};

fn existence_name(title: &str) -> String {
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    let title = PREFIX.get_or_init(|| Regex::new(r"(?i)^(missing[\s-]?page[:：]\s*|duplicate[\s-]?page[:：]\s*|possible[\s-]?duplicate[:：]\s*|缺失页面[:：]\s*|缺少页面[:：]\s*|重复页面[:：]\s*|疑似重复[:：]\s*)").unwrap()).replace(title.trim_start(), "");
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .nfkc()
        .collect::<String>()
        .trim()
        .to_owned()
}

pub(super) async fn run(
    pages: &[Page],
    input: &WikiLintRunInput,
    llm: Option<&dyn WikiIngestLlm>,
    cancellation: &CancellationToken,
) -> Result<Vec<WikiLintFinding>, WikiFailure> {
    let model = input
        .model_ref
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty() && *model != "auto")
        .ok_or_else(|| {
            WikiFailure::invalid_input("modelRef", "semantic lint requires explicit modelRef")
        })?;
    let mut existing = BTreeSet::new();
    let mut summaries = Vec::new();
    for page in pages.iter().filter(|page| basename(&page.path) != "log.md") {
        if cancellation.is_cancelled() {
            return Err(WikiFailure::cancelled());
        }
        existing.insert(existence_name(
            basename(&page.path).strip_suffix(".md").unwrap(),
        ));
        existing.insert(existence_name(&page.title));
        let mut preview = utf16_prefix(&page.content, 500);
        if page.content.encode_utf16().count() > 500 {
            preview.push_str("...");
        }
        summaries.push(format!("### {}\n{preview}", page.path));
    }
    if summaries.is_empty() {
        return Ok(Vec::new());
    }
    let llm = llm.ok_or(WikiFailure::OwnerUnavailable)?;
    let sample = utf16_prefix(&summaries.join("\n"), 2000);
    let prompt = [
        "You are a wiki quality analyst. Review the following wiki page summaries and identify issues.".to_owned(),
        String::new(),
        crate::ingest::prompts::language_rule(input.output_language.as_deref(), &sample),
        String::new(),
        "For each issue, output exactly this format:\n\n---LINT: type | severity | Short title---\nDescription of the issue.\nPAGES: page1.md, page2.md\n---END LINT---\n\nTypes:\n- contradiction: two or more pages make conflicting claims\n- stale: information that appears outdated or superseded\n- missing-page: an important concept is heavily referenced but has no dedicated page\n- suggestion: a question or source worth adding to the wiki\nFor missing-page findings, Short title must be only the exact missing concept or entity name, without explanatory prefixes or suffixes.\n\nSeverities:\n- warning: should be addressed\n- info: nice to have\n\nOnly report genuine issues. Do not invent problems. Output ONLY the ---LINT--- blocks, no other text.\n\n## Wiki Pages\n".to_owned(),
        summaries.join("\n\n"),
    ].join("\n");
    let response = llm
        .generate_cancellable(
            WikiIngestLlmRequest {
                model_ref: Some(model.to_owned()),
                messages: vec![WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::User,
                    content: prompt,
                }],
                options: WikiIngestLlmOptions::default(),
            },
            cancellation.clone(),
        )
        .await?;
    if cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    parse(&response.text, pages, &existing)
}

fn parse(
    raw: &str,
    pages: &[Page],
    existing: &BTreeSet<String>,
) -> Result<Vec<WikiLintFinding>, WikiFailure> {
    static BLOCKS: OnceLock<Regex> = OnceLock::new();
    static PAGES: OnceLock<Regex> = OnceLock::new();
    let blocks = BLOCKS.get_or_init(|| Regex::new(r"---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---").unwrap());
    let pages_regex = PAGES.get_or_init(|| Regex::new(r"(?m)^PAGES:\s*(.+)$").unwrap());
    let mut findings = Vec::new();
    for capture in blocks.captures_iter(raw) {
        let kind = capture[1].trim().to_lowercase();
        let title = capture[3].trim();
        if kind == "missing-page" && existing.contains(&existence_name(title)) {
            continue;
        }
        let body = capture[4].trim();
        let mut finding = WikiLintFinding::new(
            WikiLintType::Semantic,
            if capture[2].trim().eq_ignore_ascii_case("warning") {
                WikiLintSeverity::Warning
            } else {
                WikiLintSeverity::Info
            },
            title.to_owned(),
            format!("[{kind}] {}", pages_regex.replace(body, "").trim()),
        );
        if let Some(capture) = pages_regex.captures(body) {
            for target in capture[1].split(',').map(str::trim) {
                let normalized = normalize_target(target);
                if let Some(page) = pages
                    .iter()
                    .find(|page| normalize_target(&page.path) == normalized)
                {
                    finding.affected_pages.push(format!("wiki/{}", page.path));
                } else {
                    let matches = pages
                        .iter()
                        .filter(|page| normalize_target(basename(&page.path)) == normalized)
                        .collect::<Vec<_>>();
                    if matches.len() == 1 {
                        finding
                            .affected_pages
                            .push(format!("wiki/{}", matches[0].path));
                    }
                }
            }
        }
        findings.push(finding);
    }
    Ok(findings)
}
