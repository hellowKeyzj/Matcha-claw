pub(crate) const UNION_FRONTMATTER_FIELDS: &[&str] = &["sources", "tags", "related"];
pub(crate) const LOCKED_FRONTMATTER_FIELDS: &[&str] = &["type", "title", "created"];

pub(crate) fn sanitize_ingested_file_content(content: &str) -> String {
    let cleaned = strip_outer_code_fence(content);
    let cleaned = strip_frontmatter_key_prefix(&cleaned);
    let cleaned = add_missing_opening_frontmatter_fence(&cleaned);
    repair_wikilink_lists_in_frontmatter(&cleaned)
}

pub(crate) fn parse_frontmatter_array(content: &str, field: &str) -> Vec<String> {
    let Some(bounds) = frontmatter_bounds(content) else {
        return Vec::new();
    };
    let frontmatter = &content[bounds.body_start..bounds.body_end];
    let lines = frontmatter.lines().collect::<Vec<_>>();
    let prefix = format!("{field}:");

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with(&prefix) {
            continue;
        }
        let rest = trimmed[prefix.len()..].trim();
        if rest.starts_with('[') && rest.ends_with(']') {
            return split_inline_array(&rest[1..rest.len() - 1]);
        }

        let mut values = Vec::new();
        for item in lines.iter().skip(index + 1) {
            let item_trimmed = item.trim_start();
            if let Some(value) = item_trimmed.strip_prefix("- ") {
                values.push(unquote(value.trim()).to_owned());
            } else if !item.starts_with(' ') && !item.starts_with('\t') {
                break;
            }
        }
        return values;
    }

    Vec::new()
}

pub(crate) fn write_frontmatter_array(content: &str, field: &str, values: &[String]) -> String {
    let Some(bounds) = frontmatter_bounds(content) else {
        return content.to_owned();
    };
    let frontmatter = &content[bounds.body_start..bounds.body_end];
    let array = format!(
        "{field}: [{}]",
        values
            .iter()
            .map(|value| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let mut lines = Vec::new();
    let mut replaced = false;
    let source_lines = frontmatter.lines().collect::<Vec<_>>();
    let mut index = 0;
    while index < source_lines.len() {
        let line = source_lines[index];
        if line.trim_start().starts_with(&format!("{field}:")) {
            lines.push(array.clone());
            replaced = true;
            index += 1;
            while index < source_lines.len()
                && (source_lines[index].starts_with(' ') || source_lines[index].starts_with('\t'))
                && source_lines[index].trim_start().starts_with("- ")
            {
                index += 1;
            }
            continue;
        }
        lines.push(line.to_owned());
        index += 1;
    }
    if !replaced {
        lines.push(array);
    }

    replace_frontmatter_body(content, bounds, &lines.join(bounds.newline))
}

pub(crate) fn merge_array_fields_into_content(
    new_content: &str,
    existing_content: Option<&str>,
    fields: &[&str],
) -> String {
    let Some(existing_content) = existing_content.filter(|content| !content.is_empty()) else {
        return new_content.to_owned();
    };
    if frontmatter_bounds(existing_content).is_none() {
        return new_content.to_owned();
    }

    let mut result = new_content.to_owned();
    let mut changed = false;
    for field in fields {
        let existing = parse_frontmatter_array(existing_content, field);
        if existing.is_empty() {
            continue;
        }
        let incoming = parse_frontmatter_array(&result, field);
        let merged = dedupe_case_insensitive(existing.into_iter().chain(incoming).collect());
        if merged.len() == parse_frontmatter_array(&result, field).len()
            && merged
                .iter()
                .zip(parse_frontmatter_array(&result, field))
                .all(|(left, right)| left == &right)
        {
            continue;
        }
        result = write_frontmatter_array(&result, field, &merged);
        changed = true;
    }

    if changed {
        result
    } else {
        new_content.to_owned()
    }
}

pub(crate) fn apply_locked_frontmatter_fields(
    content: &str,
    existing_content: &str,
    fields: &[&str],
) -> String {
    let mut result = content.to_owned();
    for field in fields {
        if let Some(value) = parse_frontmatter_scalar(existing_content, field) {
            if !value.is_empty() {
                result = set_frontmatter_scalar(&result, field, &value);
            }
        }
    }
    result
}

pub(crate) fn set_frontmatter_scalar(content: &str, field: &str, value: &str) -> String {
    let Some(bounds) = frontmatter_bounds(content) else {
        return content.to_owned();
    };
    let frontmatter = &content[bounds.body_start..bounds.body_end];
    let mut lines = Vec::new();
    let mut replaced = false;
    let source_lines = frontmatter.lines().collect::<Vec<_>>();
    let prefix = format!("{field}:");

    for (index, line) in source_lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if !replaced && trimmed.starts_with(&prefix) {
            let rest = trimmed[prefix.len()..].trim_start();
            let next_is_block_item = source_lines
                .get(index + 1)
                .is_some_and(|next| next.trim_start().starts_with("- "));
            if !rest.starts_with('[') && !next_is_block_item {
                lines.push(format!("{field}: {value}"));
                replaced = true;
                continue;
            }
        }
        lines.push((*line).to_owned());
    }
    if !replaced {
        lines.push(format!("{field}: {value}"));
    }

    replace_frontmatter_body(content, bounds, &lines.join(bounds.newline))
}

fn strip_outer_code_fence(content: &str) -> String {
    let Some((open_start, after_open)) = opening_document_fence(content) else {
        return content.to_owned();
    };
    let after_open_content = &content[after_open..];

    if let Some(close_start) = final_closing_fence_start(after_open_content) {
        return after_open_content[..close_start].to_owned();
    }

    if let Some(bounds) = frontmatter_bounds(after_open_content) {
        let mut rest = &after_open_content[bounds.close_end..];
        if rest.starts_with("\r\n") {
            rest = &rest[2..];
        } else if rest.starts_with('\n') {
            rest = &rest[1..];
        }
        if let Some((_, after_fence)) = opening_fence_line(rest, 0) {
            return format!(
                "{}{}",
                &after_open_content[..bounds.close_end],
                &rest[after_fence..]
            );
        }
    }

    content[open_start..].to_owned()
}

fn strip_frontmatter_key_prefix(content: &str) -> String {
    let Some((line, next)) = next_line(content, 0) else {
        return content.to_owned();
    };
    let trimmed = line.trim();
    if trimmed.eq_ignore_ascii_case("frontmatter:") {
        if let Some((next_line, _)) = next_line(content, next) {
            if next_line.trim() == "---" {
                return content[next..].to_owned();
            }
        }
    }
    content.to_owned()
}

fn add_missing_opening_frontmatter_fence(content: &str) -> String {
    if first_non_empty_line(content).is_some_and(|(_, line)| line.trim() == "---") {
        return content.to_owned();
    }
    let Some((first_index, first_line)) = first_non_empty_line(content) else {
        return content.to_owned();
    };
    if !starts_with_frontmatter_key(first_line.trim()) {
        return content.to_owned();
    }

    let mut line_index = 0usize;
    let mut byte_index = 0usize;
    while let Some((line, next)) = next_line(content, byte_index) {
        if byte_index > first_index {
            if line.trim() == "---" && line_index <= 30 {
                return format!("---\n{}", &content[first_index..]);
            }
            if line.trim_start().starts_with('#') {
                break;
            }
        }
        line_index += 1;
        byte_index = next;
        if line_index > 30 {
            break;
        }
    }

    content.to_owned()
}

fn repair_wikilink_lists_in_frontmatter(content: &str) -> String {
    let Some(bounds) = frontmatter_bounds(content) else {
        return content.to_owned();
    };
    let frontmatter = &content[bounds.body_start..bounds.body_end];
    let repaired = frontmatter
        .lines()
        .map(repair_wikilink_list_line)
        .collect::<Vec<_>>()
        .join(bounds.newline);
    replace_frontmatter_body(content, bounds, &repaired)
}

fn repair_wikilink_list_line(line: &str) -> String {
    let Some(colon) = line.find(':') else {
        return line.to_owned();
    };
    let key = line[..colon].trim();
    if key.is_empty()
        || !key.chars().all(|character| {
            character == '_' || character == '-' || character.is_ascii_alphanumeric()
        })
    {
        return line.to_owned();
    }
    let value = line[colon + 1..].trim();
    let items = value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    if items.len() < 2
        || !items
            .iter()
            .all(|item| item.starts_with("[[") && item.ends_with("]]"))
    {
        return line.to_owned();
    }
    let prefix = &line[..colon + 1];
    format!(
        "{prefix} [{}]",
        items
            .iter()
            .map(|item| format!("\"{item}\""))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

pub(crate) fn parse_frontmatter_scalar(content: &str, field: &str) -> Option<String> {
    let bounds = frontmatter_bounds(content)?;
    let frontmatter = &content[bounds.body_start..bounds.body_end];
    let prefix = format!("{field}:");
    for (index, line) in frontmatter.lines().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with(&prefix) {
            continue;
        }
        let rest = trimmed[prefix.len()..].trim();
        let next_is_block_item = frontmatter
            .lines()
            .nth(index + 1)
            .is_some_and(|next| next.trim_start().starts_with("- "));
        if rest.starts_with('[') || next_is_block_item {
            return None;
        }
        return Some(unquote(rest).to_owned());
    }
    None
}

#[derive(Clone, Copy)]
struct FrontmatterBounds<'a> {
    body_start: usize,
    body_end: usize,
    close_end: usize,
    newline: &'a str,
}

fn frontmatter_bounds(content: &str) -> Option<FrontmatterBounds<'_>> {
    let (opening, body_start) = next_line(content, 0)?;
    if opening.trim() != "---" {
        return None;
    }
    let newline = if content[..body_start].ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut close_start = body_start;
    while let Some((line, next)) = next_line(content, close_start) {
        if line.trim() == "---" {
            let body_end = if close_start == body_start {
                close_start
            } else if content[..close_start].ends_with("\r\n") {
                close_start - 2
            } else {
                close_start - 1
            };
            return Some(FrontmatterBounds {
                body_start,
                body_end,
                close_end: close_start + line.len(),
                newline,
            });
        }
        close_start = next;
    }
    None
}

fn replace_frontmatter_body(content: &str, bounds: FrontmatterBounds<'_>, body: &str) -> String {
    format!(
        "{}{}{}{}",
        &content[..bounds.body_start],
        body,
        &content[bounds.body_end..bounds.close_end],
        &content[bounds.close_end..]
    )
}

fn opening_document_fence(content: &str) -> Option<(usize, usize)> {
    let mut start = 0;
    if content.starts_with('\u{feff}') {
        start = '\u{feff}'.len_utf8();
    }
    while let Some((line, next)) = next_line(content, start) {
        if line.trim().is_empty() {
            start = next;
            continue;
        }
        return opening_fence_line(content, start).map(|(_, after)| (start, after));
    }
    None
}

fn opening_fence_line(content: &str, start: usize) -> Option<(usize, usize)> {
    let (line, next) = next_line(content, start)?;
    let trimmed = line.trim();
    let info = trimmed.strip_prefix("```")?.trim();
    (info.is_empty()
        || info.eq_ignore_ascii_case("yaml")
        || info.eq_ignore_ascii_case("md")
        || info.eq_ignore_ascii_case("markdown"))
    .then_some((start, next))
}

fn final_closing_fence_start(content: &str) -> Option<usize> {
    let mut position = 0;
    let mut last_non_empty = None;
    while let Some((line, next)) = next_line(content, position) {
        if !line.trim().is_empty() {
            last_non_empty = Some((position, line));
        }
        position = next;
    }
    let (start, line) = last_non_empty?;
    (line.trim() == "```").then_some(if start > 0 && content[..start].ends_with("\r\n") {
        start - 2
    } else if start > 0 && content[..start].ends_with('\n') {
        start - 1
    } else {
        start
    })
}

fn first_non_empty_line(content: &str) -> Option<(usize, &str)> {
    let mut position = 0;
    while let Some((line, next)) = next_line(content, position) {
        if !line.trim().is_empty() {
            return Some((position, line));
        }
        position = next;
    }
    None
}

fn starts_with_frontmatter_key(line: &str) -> bool {
    [
        "type", "title", "created", "updated", "tags", "related", "sources",
    ]
    .iter()
    .any(|key| {
        line.get(..key.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(key))
            && line[key.len()..].trim_start().starts_with(':')
    })
}

fn next_line(content: &str, start: usize) -> Option<(&str, usize)> {
    if start > content.len() {
        return None;
    }
    if start == content.len() {
        return None;
    }
    let rest = &content[start..];
    if let Some(offset) = rest.find('\n') {
        let end = start + offset;
        let line_end = if end > start && content.as_bytes()[end - 1] == b'\r' {
            end - 1
        } else {
            end
        };
        Some((&content[start..line_end], end + 1))
    } else {
        Some((rest, content.len()))
    }
}

fn split_inline_array(input: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in input.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote == Some('"') {
            escaped = true;
            continue;
        }
        if quote == Some(character) {
            quote = None;
            continue;
        }
        if quote.is_none() && (character == '"' || character == '\'') {
            quote = Some(character);
            continue;
        }
        if quote.is_none() && character == ',' {
            let value = current.trim();
            if !value.is_empty() {
                values.push(unquote(value).to_owned());
            }
            current.clear();
        } else {
            current.push(character);
        }
    }
    let value = current.trim();
    if !value.is_empty() {
        values.push(unquote(value).to_owned());
    }
    values
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn dedupe_case_insensitive(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        if !out
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&value))
        {
            out.push(value);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_common_llm_frontmatter_damage() {
        let wrapped = "```yaml\n---\ntype: entity\nrelated: [[a]], [[b]]\n---\n# Body\n```\n";
        let cleaned = sanitize_ingested_file_content(wrapped);
        assert!(cleaned.starts_with("---\ntype: entity"));
        assert!(cleaned.contains("related: [\"[[a]]\", \"[[b]]\"]"));
        assert!(!cleaned.starts_with("```"));

        let prefixed = sanitize_ingested_file_content("frontmatter:\n---\ntitle: Foo\n---\n# Foo");
        assert!(prefixed.starts_with("---\ntitle: Foo"));

        let missing_open = sanitize_ingested_file_content("type: concept\ntitle: Foo\n---\n# Foo");
        assert!(missing_open.starts_with("---\ntype: concept"));
    }

    #[test]
    fn parses_writes_and_merges_frontmatter_arrays() {
        let existing = "---\nsources:\n  - A.md\ntags: [old]\n---\nold body";
        let incoming = "---\nsources: [a.md, B.md]\ntags: [new]\nrelated: [Foo]\n---\nnew body";
        assert_eq!(parse_frontmatter_array(existing, "sources"), vec!["A.md"]);

        let merged =
            merge_array_fields_into_content(incoming, Some(existing), UNION_FRONTMATTER_FIELDS);
        assert!(merged.contains("sources: [\"A.md\", \"B.md\"]"));
        assert!(merged.contains("tags: [\"old\", \"new\"]"));
        assert!(merged.contains("related: [Foo]"));
    }

    #[test]
    fn restores_locked_scalar_fields() {
        let existing = "---\ntype: entity\ntitle: Stable\ncreated: 2026-01-01\n---\nold";
        let incoming =
            "---\ntype: concept\ntitle: Drift\ncreated: 2026-02-02\nupdated: 2026-02-02\n---\nnew";
        let restored =
            apply_locked_frontmatter_fields(incoming, existing, LOCKED_FRONTMATTER_FIELDS);
        assert!(restored.contains("type: entity"));
        assert!(restored.contains("title: Stable"));
        assert!(restored.contains("created: 2026-01-01"));
        assert!(
            set_frontmatter_scalar(&restored, "updated", "2026-03-03")
                .contains("updated: 2026-03-03")
        );
    }
}
