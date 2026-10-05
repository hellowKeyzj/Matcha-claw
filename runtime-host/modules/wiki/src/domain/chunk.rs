use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiChunk {
    chunk_id: String,
    ordinal: usize,
    text: String,
    heading_path: String,
}

impl WikiChunk {
    pub fn new(chunk_id: String, ordinal: usize, text: String, heading_path: String) -> Self {
        Self {
            chunk_id,
            ordinal,
            text,
            heading_path,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn heading_path(&self) -> &str {
        &self.heading_path
    }
}

// ECMAScript whitespace differs from Rust's Unicode White_Space (notably U+0085/U+FEFF).
const WHITESPACE: &str =
    r"[\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
static FRONTMATTER_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(^|\n)---{WHITESPACE}*(\n|$)")).expect("frontmatter pattern")
});
static HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(#{{1,6}}){WHITESPACE}+([^\r\n\u{{2028}}\u{{2029}}]+?){WHITESPACE}*$"
    ))
    .expect("heading pattern")
});
#[derive(Clone, Copy)]
enum Separator {
    Paragraph,
    Line,
    Sentence,
    Whitespace,
}

pub fn chunk_markdown_with_overlap(
    relative_path: &str,
    content: &str,
    target_chars: usize,
    overlap_chars: usize,
) -> Vec<WikiChunk> {
    let target_chars = target_chars.max(1);
    let overlap_chars = if overlap_chars >= target_chars {
        target_chars / 2
    } else {
        overlap_chars
    };
    let body = strip_frontmatter(content);
    let mut chunks = Vec::new();
    let mut headings: Vec<(usize, &str)> = Vec::new();
    let mut heading_path = String::new();
    let mut section_start = 0;
    let mut cursor = 0;
    let mut open_fence = None;
    for line in body.split('\n') {
        if let Some(marker) = fence_marker(line) {
            match open_fence {
                None => open_fence = Some(marker),
                Some(open) if is_fence_close(line, open) => open_fence = None,
                Some(_) => {}
            }
        } else if open_fence.is_none() {
            if let Some(captures) = HEADING.captures(line) {
                emit_section(
                    relative_path,
                    body[section_start..cursor]
                        .strip_suffix('\n')
                        .unwrap_or(&body[section_start..cursor]),
                    &heading_path,
                    target_chars,
                    overlap_chars,
                    &mut chunks,
                );
                let level = captures[1].len();
                let title = captures
                    .get(2)
                    .expect("heading title")
                    .as_str()
                    .trim_matches(is_whitespace);
                headings.retain(|(previous, _)| *previous < level);
                headings.push((level, title));
                heading_path = headings
                    .iter()
                    .filter(|(_, title)| !title.is_empty())
                    .map(|(level, title)| format!("{} {title}", "#".repeat(*level)))
                    .collect::<Vec<_>>()
                    .join(" > ");
                section_start = cursor;
            }
        }
        cursor += line.len() + 1;
    }
    emit_section(
        relative_path,
        &body[section_start..],
        &heading_path,
        target_chars,
        overlap_chars,
        &mut chunks,
    );
    chunks
}

fn is_whitespace(character: char) -> bool {
    matches!(character, '\t'..='\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn strip_frontmatter(content: &str) -> &str {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return content;
    }
    let rest = &content[4..];
    let Some(closing) = FRONTMATTER_END.find(rest) else {
        return content;
    };
    let closing = rest[closing.start()..]
        .strip_prefix('\n')
        .unwrap_or(&rest[closing.start()..]);
    closing[3..].trim_start_matches(is_whitespace)
}

fn fence_marker(line: &str) -> Option<&str> {
    let marker = *line.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let width = line.bytes().take_while(|byte| *byte == marker).count();
    (width >= 3).then_some(&line[..width])
}

fn is_fence_close(line: &str, marker: &str) -> bool {
    line.starts_with(marker) && line.trim_matches(is_whitespace) == marker
}

struct Piece {
    text: String,
    units: usize,
}

impl Piece {
    fn new(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            units: text.encode_utf16().count(),
        }
    }
}

fn emit_section(
    relative_path: &str,
    section: &str,
    heading_path: &str,
    target_chars: usize,
    overlap_chars: usize,
    chunks: &mut Vec<WikiChunk>,
) {
    if section.trim_matches(is_whitespace).is_empty() {
        return;
    }
    let pieces = if section.encode_utf16().count() <= target_chars {
        vec![Piece::new(section)]
    } else {
        pack_pieces(tokenize_pieces(section, target_chars), target_chars)
    };
    let mut overlap = String::new();
    for piece in pieces {
        // Use the preceding unaugmented chunk, including code/table chunks.
        let next_overlap = overlap_tail(&piece.text, overlap_chars).to_owned();
        let text = if overlap.is_empty() {
            piece.text
        } else {
            overlap.push_str(&piece.text);
            overlap
        };
        let ordinal = chunks.len();
        chunks.push(WikiChunk::new(
            format!("{relative_path}#{ordinal}"),
            ordinal,
            text,
            heading_path.to_owned(),
        ));
        overlap = next_overlap;
    }
}

fn tokenize_pieces(text: &str, target_chars: usize) -> Vec<Piece> {
    let lines = text.split('\n').collect::<Vec<_>>();
    let mut pieces = Vec::new();
    let mut index = 0;
    let mut cursor = 0;
    while index < lines.len() {
        let line = lines[index];
        if line.trim_matches(is_whitespace).is_empty() {
            cursor += line.len() + 1;
            index += 1;
            continue;
        }
        let start = cursor;
        let mut end = start + line.len();
        let marker = fence_marker(line);
        let is_table = line.starts_with('|')
            && lines
                .get(index + 1)
                .is_some_and(|line| line.starts_with('|'));
        if let Some(marker) = marker {
            cursor += line.len() + 1;
            index += 1;
            while index < lines.len() {
                let line = lines[index];
                end = cursor + line.len();
                cursor = end + 1;
                index += 1;
                if is_fence_close(line, marker) {
                    break;
                }
            }
        } else {
            while index < lines.len()
                && if is_table {
                    lines[index].starts_with('|')
                } else {
                    !lines[index].trim_matches(is_whitespace).is_empty()
                        && fence_marker(lines[index]).is_none()
                }
            {
                end = cursor + lines[index].len();
                cursor = end + 1;
                index += 1;
            }
        }
        let atom = &text[start..end];
        if marker.is_some() || is_table || atom.encode_utf16().count() <= target_chars {
            pieces.push(Piece::new(atom));
        } else {
            split_text(atom, target_chars, &mut pieces);
        }
    }
    pieces
}

fn split_keeping_separator(text: &str, separator: Separator) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut cursor = text.char_indices().peekable();
    while let Some((offset, character)) = cursor.next() {
        let is_separator = match separator {
            Separator::Paragraph => {
                character == '\n' && cursor.peek().is_some_and(|(_, next)| *next == '\n')
            }
            Separator::Line => character == '\n',
            Separator::Sentence => {
                is_sentence_separator(character)
                    || (character == '.'
                        && cursor.peek().is_some_and(|(_, next)| is_whitespace(*next)))
            }
            Separator::Whitespace => is_whitespace(character),
        };
        if !is_separator {
            continue;
        }
        let mut end = offset + character.len_utf8();
        if matches!(separator, Separator::Sentence) && character != '.' {
            while cursor
                .peek()
                .is_some_and(|(_, next)| is_sentence_separator(*next))
            {
                let (offset, next) = cursor.next().expect("peeked punctuation");
                end = offset + next.len_utf8();
            }
        }
        while cursor.peek().is_some_and(|(_, next)| match separator {
            Separator::Paragraph | Separator::Line => *next == '\n',
            Separator::Sentence | Separator::Whitespace => is_whitespace(*next),
        }) {
            let (offset, next) = cursor.next().expect("peeked separator");
            end = offset + next.len_utf8();
        }
        pieces.push(&text[start..end]);
        start = end;
    }
    if start < text.len() {
        pieces.push(&text[start..]);
    }
    pieces
}

fn is_sentence_separator(character: char) -> bool {
    matches!(character, '。' | '！' | '？' | '!' | '?' | '；' | ';')
}

fn split_text(text: &str, target_chars: usize, pieces: &mut Vec<Piece>) {
    for paragraph in split_keeping_separator(text, Separator::Paragraph) {
        if paragraph.encode_utf16().count() <= target_chars {
            pieces.push(Piece::new(paragraph));
            continue;
        }
        // Each separator is tried against the whole paragraph, not recursively against subs.
        let split = [Separator::Line, Separator::Sentence, Separator::Whitespace]
            .into_iter()
            .find_map(|separator| {
                let subs = split_keeping_separator(paragraph, separator);
                (subs.len() > 1
                    && subs
                        .iter()
                        .all(|text| text.encode_utf16().count() <= target_chars))
                .then_some(subs)
            });
        if let Some(subs) = split {
            pieces.extend(subs.into_iter().map(Piece::new));
            continue;
        }
        // UTF-16 budgets contract inward at a surrogate pair. If even one scalar
        // exceeds the budget, emit it whole so tiny targets advance without losing emoji.
        let mut rest = paragraph;
        while !rest.is_empty() {
            let mut units = 0;
            let end = rest
                .char_indices()
                .find_map(|(index, character)| {
                    units += character.len_utf16();
                    (units > target_chars).then_some(index)
                })
                .unwrap_or(rest.len());
            let end = if end == 0 {
                rest.chars().next().expect("nonempty slice").len_utf8()
            } else {
                end
            };
            pieces.push(Piece::new(&rest[..end]));
            rest = &rest[end..];
        }
    }
}

fn pack_pieces(pieces: Vec<Piece>, target_chars: usize) -> Vec<Piece> {
    let mut packed: Vec<Piece> = Vec::new();
    for piece in pieces {
        if let Some(previous) = packed.last_mut() {
            if previous.units + piece.units <= target_chars {
                previous.text.push_str(&piece.text);
                previous.units += piece.units;
                continue;
            }
        }
        packed.push(piece);
    }
    let mut merged: Vec<Piece> = Vec::with_capacity(packed.len());
    for piece in packed {
        if let Some(previous) = merged.last_mut() {
            if previous.units < 200 && previous.units + piece.units <= target_chars.max(1500) {
                previous.text.push_str(&piece.text);
                previous.units += piece.units;
                continue;
            }
        }
        merged.push(piece);
    }
    merged
}

fn overlap_tail(text: &str, overlap_chars: usize) -> &str {
    let mut remaining = overlap_chars;
    let mut start = 0;
    for (index, character) in text.char_indices().rev() {
        let width = character.len_utf16();
        if width > remaining {
            start = index + character.len_utf8();
            break;
        }
        remaining -= width;
    }
    let tail = &text[start..];
    if let Some((offset, character)) = tail.char_indices().find(|(_, character)| {
        matches!(character, '。' | '！' | '？' | '!' | '?' | '.' | ';' | '；')
    }) {
        let rest = tail[offset + character.len_utf8()..].trim_start_matches(is_whitespace);
        if !rest.is_empty() {
            return rest;
        }
    }
    if let Some((offset, character)) = tail
        .char_indices()
        .find(|(_, character)| is_whitespace(*character))
    {
        let rest = &tail[offset + character.len_utf8()..];
        if !rest.is_empty() {
            return rest;
        }
    }
    tail
}
