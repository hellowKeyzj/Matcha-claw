use std::{collections::BTreeSet, path::Path};

use super::super::model::WikiSearchHit;
use super::{SearchPage, extract_search_images, search_snippet};

pub(super) fn score_page(
    page: &SearchPage,
    tokens: &[String],
    phrase: &str,
    query: &str,
    include_content: bool,
) -> Option<WikiSearchHit> {
    let file_name = Path::new(&page.relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let title_lower = format!("{} {file_name}", page.title).to_lowercase();
    let content_lower = page.content.to_lowercase();
    let stem = file_name.trim_end_matches(".md").to_lowercase();
    let filename_exact = !phrase.is_empty() && stem == phrase;
    let title_has_phrase = !phrase.is_empty() && title_lower.contains(phrase);
    let phrase_occurrences = if phrase.is_empty() {
        0
    } else {
        content_lower.match_indices(phrase).take(10).count()
    };
    let title_tokens = token_match_score(&title_lower, tokens);
    let content_tokens = token_match_score(&content_lower, tokens);
    if !filename_exact
        && !title_has_phrase
        && phrase_occurrences == 0
        && title_tokens == 0
        && content_tokens == 0
    {
        return None;
    }
    let score = (if filename_exact { 200.0 } else { 0.0 })
        + (if title_has_phrase { 50.0 } else { 0.0 })
        + phrase_occurrences as f64 * 20.0
        + title_tokens as f64 * 5.0
        + content_tokens as f64;
    let anchor = if phrase_occurrences > 0 {
        phrase
    } else {
        tokens
            .iter()
            .find(|token| content_lower.contains(token.as_str()))
            .map(String::as_str)
            .unwrap_or(query)
    };
    let mut hit = WikiSearchHit::new(
        page.relative_path.clone(),
        page.title.clone(),
        score,
        vec![search_snippet(&page.content, anchor)],
    );
    hit.title_match = title_tokens > 0 || title_has_phrase;
    hit.images = extract_search_images(&page.content);
    hit.content = include_content.then(|| page.content.clone());
    Some(hit)
}

pub(super) fn tokenize_query(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let mut tokens = BTreeSet::new();
    for token in lower
        .split(is_query_separator)
        .filter(|token| token.chars().count() > 1 && !is_stop_word(token))
    {
        let chars = token.chars().collect::<Vec<_>>();
        let has_cjk = chars
            .iter()
            .any(|ch| ('\u{3400}'..='\u{9fff}').contains(ch));
        if has_cjk && chars.len() > 2 {
            for pair in chars.windows(2) {
                tokens.insert(pair.iter().collect::<String>());
            }
            for ch in chars {
                let single = ch.to_string();
                if !is_stop_word(&single) {
                    tokens.insert(single);
                }
            }
        }
        tokens.insert(token.to_owned());
    }
    tokens.into_iter().collect()
}

pub(super) fn query_phrase(query: &str) -> String {
    query
        .to_lowercase()
        .trim_matches(is_query_separator)
        .to_owned()
}

fn token_match_score(lower: &str, tokens: &[String]) -> usize {
    tokens
        .iter()
        .filter(|token| lower.contains(token.as_str()))
        .count()
}

fn is_query_separator(ch: char) -> bool {
    ch.is_whitespace()
        || ch.is_ascii_punctuation()
        || matches!(
            ch,
            '，' | '。'
                | '！'
                | '？'
                | '、'
                | '；'
                | '：'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '（'
                | '）'
                | '·'
                | '～'
                | '…'
        )
}

fn is_stop_word(token: &str) -> bool {
    matches!(
        token,
        "的" | "是"
            | "了"
            | "什么"
            | "在"
            | "有"
            | "和"
            | "与"
            | "对"
            | "从"
            | "the"
            | "is"
            | "a"
            | "an"
            | "what"
            | "how"
            | "are"
            | "was"
            | "were"
            | "do"
            | "does"
            | "did"
            | "be"
            | "been"
            | "being"
            | "have"
            | "has"
            | "had"
            | "it"
            | "its"
            | "in"
            | "on"
            | "at"
            | "to"
            | "for"
            | "of"
            | "with"
            | "by"
            | "this"
            | "that"
            | "these"
            | "those"
    )
}
