use crate::domain::{WikiReviewItem, WikiReviewOption, WikiReviewType, now_ms};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedFileBlock {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ParseFileBlocksResult {
    pub blocks: Vec<ParsedFileBlock>,
    pub warnings: Vec<String>,
    pub truncated_paths: Vec<String>,
}

pub(crate) fn parse_file_blocks(text: &str) -> ParseFileBlocksResult {
    let normalized = text.replace("\r\n", "\n");
    let lines = normalized.split('\n').collect::<Vec<_>>();
    let mut blocks = Vec::new();
    let mut warnings = Vec::new();
    let mut truncated_paths = Vec::new();

    let mut index = 0;
    while index < lines.len() {
        let Some(path) = parse_opener_line(lines[index]) else {
            index += 1;
            continue;
        };
        index += 1;

        let mut content_lines = Vec::new();
        let mut fence_marker = None;
        let mut fence_len = 0usize;
        let mut closed = false;

        while index < lines.len() {
            let line = lines[index];
            if let Some((marker, len)) = fence_line(line) {
                if fence_marker.is_none() {
                    fence_marker = Some(marker);
                    fence_len = len;
                } else if fence_marker == Some(marker) && len >= fence_len {
                    fence_marker = None;
                    fence_len = 0;
                }
                content_lines.push(line);
                index += 1;
                continue;
            }

            if fence_marker.is_none() && is_closer_line(line) {
                closed = true;
                index += 1;
                break;
            }

            content_lines.push(line);
            index += 1;
        }

        if !closed {
            let path_label = if path.is_empty() { "(unnamed)" } else { &path };
            warnings.push(format!(
                "FILE block \"{path_label}\" was not closed before end of stream — likely truncation (model hit max_tokens, timeout, or connection dropped). Block dropped."
            ));
            if is_safe_ingest_path(&path) {
                truncated_paths.push(path);
            }
            continue;
        }

        if path.is_empty() {
            warnings.push(
                "FILE block with empty path skipped (LLM omitted the path after `---FILE:`)."
                    .to_owned(),
            );
            continue;
        }

        if !is_safe_ingest_path(&path) {
            warnings.push(format!(
                "FILE block with unsafe path \"{path}\" rejected (must be under wiki/, no .., no absolute paths, and Windows-safe file names)."
            ));
            continue;
        }

        blocks.push(ParsedFileBlock {
            path,
            content: content_lines.join("\n"),
        });
    }

    ParseFileBlocksResult {
        blocks,
        warnings,
        truncated_paths,
    }
}

pub(crate) fn parse_review_blocks(text: &str, source_path: &str) -> Vec<WikiReviewItem> {
    let normalized = text.replace("\r\n", "\n");
    let lines = normalized.split('\n').collect::<Vec<_>>();
    let mut items = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let Some((review_type, title)) = parse_review_opener_line(lines[index]) else {
            index += 1;
            continue;
        };
        index += 1;
        let mut body = Vec::new();
        let mut closed = false;
        while index < lines.len() {
            let line = lines[index];
            index += 1;
            if line.trim() == "---END REVIEW---" {
                closed = true;
                break;
            }
            body.push(line);
        }
        if !closed {
            continue;
        }
        let body_text = body.join("\n");
        items.push(WikiReviewItem {
            id: String::new(),
            review_type,
            title,
            description: review_description(&body_text),
            source_path: Some(source_path.to_owned()),
            affected_pages: review_csv_line(&body_text, "PAGES:"),
            search_queries: review_pipe_line(&body_text, "SEARCH:"),
            options: review_options(&body_text),
            resolved: false,
            resolved_action: None,
            created_at: now_ms(),
        });
    }
    items
}

pub(crate) fn should_run_dedicated_review_stage(text: &str) -> bool {
    text.chars().count() >= 10_000
        || count_file_openers(text) >= 4
        || has_unclosed_review_block(text)
}

pub(crate) fn is_safe_ingest_path(path: &str) -> bool {
    if path.trim().is_empty() || path.chars().any(|character| character <= '\u{1f}') {
        return false;
    }
    if path.starts_with('/') || path.starts_with('\\') || has_windows_drive_prefix(path) {
        return false;
    }
    let normalized = path.replace('\\', "/");
    let segments = normalized.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| *segment == ".." || !is_windows_safe_path_segment(segment))
    {
        return false;
    }
    normalized.starts_with("wiki/")
}

pub(crate) fn filter_truncated_file_repair_output(
    text: &str,
    allowed_paths: &[String],
) -> (String, Vec<String>, Vec<String>) {
    let mut allowed = Vec::new();
    for path in allowed_paths {
        let normalized = path.replace('\\', "/");
        if !allowed
            .iter()
            .any(|existing: &String| existing == &normalized)
        {
            allowed.push(normalized);
        }
    }

    let mut parsed = parse_file_blocks(text);
    let mut seen = Vec::new();
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    let mut duplicates = Vec::new();

    for block in parsed.blocks {
        let path_key = block.path.replace('\\', "/");
        if !allowed.iter().any(|path| path == &path_key) {
            dropped.push(block.path);
            continue;
        }
        if seen.iter().any(|path| path == &path_key) {
            duplicates.push(block.path);
            continue;
        }
        seen.push(path_key);
        kept.push(block);
    }

    if !dropped.is_empty() {
        parsed.warnings.push(format!(
            "Dropped {} unrequested FILE block(s) from truncated repair output: {}",
            dropped.len(),
            dropped.join(", ")
        ));
    }
    if !duplicates.is_empty() {
        parsed.warnings.push(format!(
            "Dropped {} duplicate FILE block(s) from truncated repair output: {}",
            duplicates.len(),
            duplicates.join(", ")
        ));
    }

    let text = kept
        .iter()
        .map(|block| {
            format!(
                "---FILE: {}---\n{}\n---END FILE---",
                block.path,
                block.content.trim_end()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let paths = kept.into_iter().map(|block| block.path).collect();
    (text, paths, parsed.warnings)
}

fn parse_review_opener_line(line: &str) -> Option<(WikiReviewType, String)> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("---")?.trim_start();
    let rest = strip_ascii_case_prefix(rest, "REVIEW:")?.trim_start();
    let rest = rest.strip_suffix("---")?.trim();
    let (raw_type, title) = rest.split_once('|')?;
    Some((parse_review_type(raw_type), title.trim().to_owned()))
}

fn parse_review_type(value: &str) -> WikiReviewType {
    match value.trim().to_ascii_lowercase().as_str() {
        "contradiction" => WikiReviewType::Contradiction,
        "duplicate" => WikiReviewType::Duplicate,
        "missing-page" => WikiReviewType::MissingPage,
        "suggestion" => WikiReviewType::Suggestion,
        _ => WikiReviewType::Confirm,
    }
}

fn review_description(body: &str) -> String {
    body.lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            !starts_with_ascii_case(trimmed, "OPTIONS:")
                && !starts_with_ascii_case(trimmed, "PAGES:")
                && !starts_with_ascii_case(trimmed, "SEARCH:")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn review_options(body: &str) -> Vec<WikiReviewOption> {
    let options = review_pipe_line(body, "OPTIONS:")
        .into_iter()
        .map(|label| WikiReviewOption::new(label.clone(), label))
        .collect::<Vec<_>>();
    if options.is_empty() {
        vec![
            WikiReviewOption::new("Approve".to_owned(), "Approve".to_owned()),
            WikiReviewOption::new("Skip".to_owned(), "Skip".to_owned()),
        ]
    } else {
        options
    }
}

fn review_csv_line(body: &str, marker: &str) -> Vec<String> {
    review_line(body, marker)
        .map(|line| split_values(line, ','))
        .unwrap_or_default()
}

fn review_pipe_line(body: &str, marker: &str) -> Vec<String> {
    review_line(body, marker)
        .map(|line| split_values(line, '|'))
        .unwrap_or_default()
}

fn review_line<'a>(body: &'a str, marker: &str) -> Option<&'a str> {
    body.lines().find_map(|line| {
        let trimmed = line.trim_start();
        strip_ascii_case_prefix(trimmed, marker).map(str::trim)
    })
}

fn split_values(line: &str, delimiter: char) -> Vec<String> {
    line.split(delimiter)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn has_unclosed_review_block(text: &str) -> bool {
    let normalized = text.replace("\r\n", "\n");
    let review_count = normalized
        .lines()
        .filter(|line| parse_review_opener_line(line).is_some())
        .count();
    let closed_count = normalized
        .lines()
        .filter(|line| line.trim() == "---END REVIEW---")
        .count();
    review_count > closed_count
}

fn count_file_openers(text: &str) -> usize {
    text.replace("\r\n", "\n")
        .lines()
        .filter(|line| parse_opener_line(line).is_some())
        .count()
}

fn parse_opener_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("---")?.trim_start();
    let rest = strip_ascii_case_prefix(rest, "FILE:")?.trim_start();
    let path = rest.strip_suffix("---")?.trim();
    Some(path.to_owned())
}

fn is_closer_line(line: &str) -> bool {
    let trimmed = line.trim();
    let Some(rest) = trimmed.strip_prefix("---") else {
        return false;
    };
    let rest = rest.trim_start();
    let Some(rest) = strip_ascii_case_prefix(rest, "END") else {
        return false;
    };
    let rest = rest.trim_start();
    let Some(rest) = strip_ascii_case_prefix(rest, "FILE") else {
        return false;
    };
    rest.trim_start() == "---"
}

fn strip_ascii_case_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        .then(|| &value[prefix.len()..])
}

fn starts_with_ascii_case(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn fence_line(line: &str) -> Option<(char, usize)> {
    let indent = line
        .chars()
        .take_while(|character| *character == ' ')
        .count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker = rest.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let len = rest
        .chars()
        .take_while(|character| *character == marker)
        .count();
    (len >= 3).then_some((marker, len))
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_windows_safe_path_segment(segment: &str) -> bool {
    if segment.is_empty()
        || segment.ends_with(' ')
        || segment.ends_with('.')
        || segment
            .chars()
            .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_markers_case_crlf_and_keeps_closer_inside_fence() {
        let text = "--- FILE: wiki/concepts/foo.md ---\r\n````\r\n```\r\n---END FILE---\r\n```\r\n````\r\nreal\r\n--- end file ---";
        let result = parse_file_blocks(text);
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].path, "wiki/concepts/foo.md");
        assert!(result.blocks[0].content.contains("---END FILE---"));
        assert!(result.blocks[0].content.contains("real"));
    }

    #[test]
    fn rejects_unsafe_paths_and_reports_truncated_safe_path() {
        assert!(is_safe_ingest_path("wiki/concepts/qwen-2.5..notes.md"));
        assert!(!is_safe_ingest_path("../config.json"));
        assert!(!is_safe_ingest_path("wiki/../config.json"));
        assert!(!is_safe_ingest_path("C:/Windows/config"));
        assert!(!is_safe_ingest_path("wiki/concepts/con.md"));
        assert!(!is_safe_ingest_path("wiki/concepts/topic."));

        let result = parse_file_blocks("---FILE: wiki/concepts/missing.md---\nbody");
        assert!(result.blocks.is_empty());
        assert_eq!(result.truncated_paths, vec!["wiki/concepts/missing.md"]);
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn drops_unclosed_reviews_and_triggers_review_stage_from_raw_generation() {
        let reviews = parse_review_blocks(
            &[
                "---REVIEW: suggestion | Closed---",
                "Description",
                "SEARCH: query one | query two",
                "---END REVIEW---",
                "---REVIEW: suggestion | Unclosed---",
                "Should be ignored",
            ]
            .join("\n"),
            "raw/sources/source.md",
        );
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].title, "Closed");

        let raw_openers = [
            "---FILE: wiki/a.md---",
            "---FILE: wiki/b.md---",
            "---FILE: wiki/c.md---",
            "---FILE: wiki/d.md---",
        ]
        .join("\n");
        assert!(parse_file_blocks(&raw_openers).blocks.is_empty());
        assert!(should_run_dedicated_review_stage(&raw_openers));
        assert!(should_run_dedicated_review_stage(
            "---REVIEW: suggestion | Needs research---\nbody"
        ));
    }

    #[test]
    fn filters_truncated_file_repair_output() {
        let requested = "wiki/concepts/recovered.md".to_owned();
        let (text, paths, warnings) = filter_truncated_file_repair_output(
            &[
                "---FILE: wiki/concepts/recovered.md---",
                "# First",
                "---END FILE---",
                "---FILE: wiki/concepts/recovered.md---",
                "# Duplicate",
                "---END FILE---",
                "---FILE: wiki/concepts/unrequested.md---",
                "# Unrequested",
                "---END FILE---",
            ]
            .join("\n"),
            &[requested.clone()],
        );
        assert_eq!(paths, vec![requested]);
        assert!(text.contains("# First"));
        assert!(!text.contains("# Duplicate"));
        assert!(!text.contains("# Unrequested"));
        assert!(
            warnings
                .iter()
                .any(|warning| warning.contains("duplicate FILE block"))
        );
        assert!(
            warnings
                .iter()
                .any(|warning| warning.contains("unrequested FILE block"))
        );
    }
}
