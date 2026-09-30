use std::collections::{BTreeMap, BTreeSet};

use unicode_normalization::UnicodeNormalization;

use super::{
    LintRunPlan, LintRuns, WikiLintFinding, WikiLintPhase, WikiLintSeverity, WikiLintType,
    pages::{Page, basename, normalize_target, tokens, utf16_prefix},
};
use crate::domain::WikiFailure;

struct IndexedPage<'a> {
    page: &'a Page,
    slug: String,
    tokens: BTreeSet<String>,
}

fn fragments(value: &str) -> BTreeSet<String> {
    let normalized = normalize_target(value).nfkc().collect::<String>();
    let chars = normalized.chars().collect::<Vec<_>>();
    if chars.len() < 2 {
        return (!normalized.is_empty())
            .then_some(normalized)
            .into_iter()
            .collect();
    }
    chars.windows(2).map(|pair| pair.iter().collect()).collect()
}

fn candidates(scores: &BTreeMap<usize, f64>, excluded: usize) -> Vec<usize> {
    let mut ranked = scores
        .iter()
        .filter(|(index, _)| **index != excluded)
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.total_cmp(left.1).then(left.0.cmp(right.0)));
    ranked
        .into_iter()
        .take(64)
        .map(|(index, _)| *index)
        .collect()
}

fn levenshtein(left: &str, right: &str) -> usize {
    let right = right.encode_utf16().collect::<Vec<_>>();
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0; right.len() + 1];
    for (index, left) in left.encode_utf16().enumerate() {
        current[0] = index + 1;
        for (column, right) in right.iter().enumerate() {
            current[column + 1] = (current[column] + 1)
                .min(previous[column + 1] + 1)
                .min(previous[column] + usize::from(left != *right));
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

fn similarity(left: &str, right: &str) -> f64 {
    let left = normalize_target(left);
    let right = normalize_target(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    if left == right {
        return 1.0;
    }
    let left_base = basename(&left);
    let right_base = basename(&right);
    if left_base == right_base {
        return 0.96;
    }
    if right.contains(&left) || left.contains(&right) {
        return 0.82;
    }
    let left_len = left_base.encode_utf16().count();
    let right_len = right_base.encode_utf16().count();
    if left_len < 5 || right_len < 5 {
        return 0.0;
    }
    1.0 - levenshtein(left_base, right_base) as f64 / left_len.max(right_len) as f64
}

fn related(
    pages: &[IndexedPage<'_>],
    token_index: &BTreeMap<String, Vec<usize>>,
    index: usize,
    target: bool,
) -> Option<String> {
    let page = &pages[index];
    let mut scores = BTreeMap::<usize, f64>::new();
    for token in &page.tokens {
        let Some(matches) = token_index.get(token) else {
            continue;
        };
        if matches.len() > 20.max(pages.len().div_ceil(4)) {
            continue;
        }
        let weight = if token.encode_utf16().count() > 1 {
            1.0
        } else {
            0.35
        };
        for candidate in matches {
            *scores.entry(*candidate).or_default() += weight;
        }
    }
    let existing = page
        .page
        .links
        .iter()
        .map(|link| normalize_target(link))
        .collect::<BTreeSet<_>>();
    let mut best = None;
    let mut best_score = 0.0;
    for candidate_index in candidates(&scores, index) {
        let candidate = &pages[candidate_index];
        if target
            && [
                &candidate.slug,
                &candidate.page.path,
                &normalize_target(basename(&candidate.page.path)),
            ]
            .iter()
            .any(|key| existing.contains(&normalize_target(key)))
        {
            continue;
        }
        let folder_bonus =
            if page.page.path.split('/').next() == candidate.page.path.split('/').next() {
                0.08
            } else {
                0.0
            };
        let score = scores[&candidate_index]
            / ((page.tokens.len().max(1) * candidate.tokens.len().max(1)) as f64).sqrt()
            + folder_bonus;
        if score > best_score {
            best = Some(format!("wiki/{}", candidate.page.path));
            best_score = score;
        }
    }
    best.filter(|_| best_score >= 0.08)
}

fn broken(
    pages: &[IndexedPage<'_>],
    fragment_index: &BTreeMap<String, Vec<usize>>,
    target: &str,
) -> Option<String> {
    let mut scores = BTreeMap::<usize, f64>::new();
    for fragment in fragments(target) {
        if let Some(matches) = fragment_index.get(&fragment) {
            for index in matches {
                *scores.entry(*index).or_default() += 1.0;
            }
        }
    }
    let mut best = None;
    let mut best_score = 0.0;
    for index in candidates(&scores, usize::MAX) {
        let page = &pages[index];
        let score = similarity(target, &page.slug)
            .max(similarity(target, &page.page.path))
            .max(similarity(target, &page.page.title));
        if score > best_score {
            best = Some(format!("wiki/{}", page.page.path));
            best_score = score;
        }
    }
    best.filter(|_| best_score >= 0.74)
}

pub(super) fn run(
    raw: &[Page],
    plan: &LintRunPlan,
    runs: &LintRuns,
) -> Result<Vec<WikiLintFinding>, WikiFailure> {
    let pages = raw
        .iter()
        .filter(|page| !matches!(basename(&page.path), "index.md" | "log.md"))
        .map(|page| IndexedPage {
            page,
            slug: page.path.strip_suffix(".md").unwrap().to_owned(),
            tokens: tokens(&format!(
                "{}\n{}\n{}",
                page.title,
                basename(page.path.strip_suffix(".md").unwrap()),
                utf16_prefix(&page.content, 4000)
            )),
        })
        .collect::<Vec<_>>();
    let mut aliases = BTreeMap::new();
    let mut token_index = BTreeMap::<String, Vec<usize>>::new();
    let mut fragment_index = BTreeMap::<String, Vec<usize>>::new();
    for (index, page) in pages.iter().enumerate() {
        aliases.insert(normalize_target(&page.slug), index);
        aliases.insert(normalize_target(basename(&page.page.path)), index);
        for token in &page.tokens {
            token_index.entry(token.clone()).or_default().push(index);
        }
        for value in [&page.slug, &page.page.path, &page.page.title] {
            for fragment in fragments(value) {
                fragment_index.entry(fragment).or_default().push(index);
            }
        }
    }
    let mut inbound = BTreeSet::new();
    for page in &pages {
        for link in &page.page.links {
            if let Some(target) = aliases
                .get(&normalize_target(link))
                .or_else(|| aliases.get(&normalize_target(basename(&link.replace('\\', "/")))))
            {
                inbound.insert(*target);
            }
        }
    }
    let config = plan.input.config.clone().unwrap_or_default().normalize();
    let ignored = config
        .ignore_pages
        .iter()
        .map(|page| normalize_target(page))
        .collect::<BTreeSet<_>>();
    let mut findings = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        if plan.cancellation.is_cancelled() {
            return Err(WikiFailure::cancelled());
        }
        let ignore = ignored.contains(&normalize_target(&page.slug))
            || ignored.contains(&normalize_target(&page.page.path));
        let path = format!("wiki/{}", page.page.path);
        if !ignore && !config.ignore_orphan && !inbound.contains(&index) {
            let mut finding = WikiLintFinding::new(
                WikiLintType::Orphan,
                WikiLintSeverity::Info,
                path.clone(),
                "No other pages link to this page.".into(),
            );
            finding.suggested_source = related(&pages, &token_index, index, false);
            findings.push(finding);
        }
        if !ignore && !config.ignore_no_outlinks && page.page.links.is_empty() {
            let mut finding = WikiLintFinding::new(
                WikiLintType::NoOutlinks,
                WikiLintSeverity::Info,
                path.clone(),
                "This page has no [[wikilink]] references to other pages.".into(),
            );
            finding.suggested_target = related(&pages, &token_index, index, true);
            findings.push(finding);
        }
        if !ignore {
            for link in &page.page.links {
                if aliases.contains_key(&normalize_target(link))
                    || aliases.contains_key(&normalize_target(basename(&link.replace('\\', "/"))))
                {
                    continue;
                }
                let mut finding = WikiLintFinding::new(
                    WikiLintType::BrokenLink,
                    WikiLintSeverity::Warning,
                    path.clone(),
                    format!("Broken link: [[{link}]] — target page not found."),
                );
                finding.broken_target = Some(link.clone());
                finding.suggested_target = broken(&pages, &fragment_index, link);
                findings.push(finding);
            }
        }
        if index % 25 == 0 || index == pages.len() - 1 {
            runs.progress(
                plan,
                WikiLintPhase::Structural,
                pages.len() + index + 1,
                pages.len() * 2,
            );
        }
    }
    Ok(findings)
}
