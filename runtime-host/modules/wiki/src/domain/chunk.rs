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
    let normalized = content.replace("\r\n", "\n");
    let body = strip_frontmatter(&normalized);
    let mut chunks = Vec::new();
    let mut headings: Vec<(usize, &str)> = Vec::new();
    let mut heading_path = String::new();
    let mut section_start = 0;
    let mut cursor = 0;
    let mut open_fence = None;
    for line in body.split_inclusive('\n') {
        let text = line.trim_end_matches('\n');
        if let Some(marker) = fence_marker(text) {
            match open_fence {
                None => open_fence = Some(marker),
                Some(open) if is_fence_close(text, open) => open_fence = None,
                Some(_) => {}
            }
        } else if open_fence.is_none() {
            if let Some((level, title)) = parse_heading(text) {
                emit_section(
                    relative_path,
                    &body[section_start..cursor],
                    &heading_path,
                    target_chars,
                    overlap_chars,
                    &mut chunks,
                );
                headings.retain(|(previous, _)| *previous < level);
                headings.push((level, title));
                heading_path = headings
                    .iter()
                    .map(|(level, title)| format!("{} {title}", "#".repeat(*level)))
                    .collect::<Vec<_>>()
                    .join(" > ");
                section_start = cursor;
            }
        }
        cursor += line.len();
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

fn strip_frontmatter(content: &str) -> &str {
    let Some(rest) = content.strip_prefix("---\n") else {
        return content;
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        if line.trim_end() == "---" {
            return &rest[offset..];
        }
    }
    content
}

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let level = line.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&level) || !line[level..].starts_with(char::is_whitespace) {
        return None;
    }
    let title = line[level..].trim();
    (!title.is_empty()).then_some((level, title))
}

fn fence_marker(line: &str) -> Option<(u8, usize)> {
    let line = line.trim_start();
    let marker = *line.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let width = line.bytes().take_while(|byte| *byte == marker).count();
    (width >= 3).then_some((marker, width))
}

fn is_fence_close(line: &str, (marker, width): (u8, usize)) -> bool {
    let trimmed = line.trim();
    trimmed.len() >= width && trimmed.bytes().all(|byte| byte == marker)
}

struct Piece {
    text: String,
    chars: usize,
    atomic: bool,
}

impl Piece {
    fn new(text: &str, atomic: bool) -> Self {
        Self {
            text: text.to_owned(),
            chars: text.chars().count(),
            atomic,
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
    let text = section.trim_end_matches('\n');
    if text.trim().is_empty() {
        return;
    }
    let pieces = if text.chars().count() <= target_chars {
        vec![Piece::new(text, false)]
    } else {
        pack_pieces(tokenize_pieces(text, target_chars), target_chars)
    };
    let mut previous: Option<Piece> = None;
    for piece in pieces {
        if piece.text.trim().is_empty() {
            continue;
        }
        let overlap = previous
            .as_ref()
            .filter(|previous| !previous.atomic && !piece.atomic)
            .map(|previous| overlap_tail(&previous.text, overlap_chars))
            .unwrap_or("");
        let ordinal = chunks.len();
        chunks.push(WikiChunk::new(
            format!("{relative_path}#{ordinal}"),
            ordinal,
            format!("{overlap}{}", piece.text),
            heading_path.to_owned(),
        ));
        previous = Some(piece);
    }
}

fn tokenize_pieces(text: &str, target_chars: usize) -> Vec<Piece> {
    let lines = text.split_inclusive('\n').collect::<Vec<_>>();
    let mut pieces = Vec::new();
    let mut index = 0;
    let mut normal = String::new();
    while index < lines.len() {
        let marker = fence_marker(lines[index]);
        let is_table = lines[index].trim_start().starts_with('|')
            && lines
                .get(index + 1)
                .is_some_and(|line| line.trim_start().starts_with('|'));
        if marker.is_none() && !is_table {
            normal.push_str(lines[index]);
            index += 1;
            continue;
        }
        split_recursive(&normal, target_chars, 0, &mut pieces);
        normal.clear();
        let start = index;
        index += 1;
        if let Some(marker) = marker {
            while index < lines.len() {
                let is_close = is_fence_close(lines[index].trim_end_matches('\n'), marker);
                index += 1;
                if is_close {
                    break;
                }
            }
        } else {
            while index < lines.len() && lines[index].trim_start().starts_with('|') {
                index += 1;
            }
        }
        pieces.push(Piece::new(&lines[start..index].concat(), true));
    }
    split_recursive(&normal, target_chars, 0, &mut pieces);
    pieces
}

fn split_recursive(text: &str, target_chars: usize, level: usize, pieces: &mut Vec<Piece>) {
    if text.is_empty() {
        return;
    }
    if text.chars().count() <= target_chars {
        pieces.push(Piece::new(text, false));
        return;
    }
    if level == 4 {
        let mut start = 0;
        for (count, (offset, _)) in text.char_indices().enumerate() {
            if count > 0 && count % target_chars == 0 {
                pieces.push(Piece::new(&text[start..offset], false));
                start = offset;
            }
        }
        pieces.push(Piece::new(&text[start..], false));
        return;
    }
    let mut cursor = text.char_indices().peekable();
    let mut start = 0;
    while let Some((offset, character)) = cursor.next() {
        let next = cursor.peek().map(|(_, character)| *character);
        let is_separator = match level {
            0 => character == '\n' && next == Some('\n'),
            1 => character == '\n',
            2 => {
                matches!(character, '。' | '！' | '？' | '!' | '?' | '；' | ';')
                    || (character == '.' && next.is_some_and(char::is_whitespace))
            }
            _ => character.is_whitespace(),
        };
        if !is_separator {
            continue;
        }
        let mut end = offset + character.len_utf8();
        while cursor.peek().is_some_and(|(_, character)| {
            if level < 2 {
                *character == '\n'
            } else {
                character.is_whitespace()
            }
        }) {
            let (offset, character) = cursor.next().expect("peeked separator");
            end = offset + character.len_utf8();
        }
        split_recursive(&text[start..end], target_chars, level + 1, pieces);
        start = end;
    }
    split_recursive(&text[start..], target_chars, level + 1, pieces);
}

fn pack_pieces(pieces: Vec<Piece>, target_chars: usize) -> Vec<Piece> {
    let mut packed: Vec<Piece> = Vec::new();
    for piece in pieces {
        if let Some(previous) = packed.last_mut() {
            if previous.chars <= target_chars
                && piece.chars <= target_chars
                && previous.chars + piece.chars <= target_chars
            {
                previous.text.push_str(&piece.text);
                previous.chars += piece.chars;
                previous.atomic |= piece.atomic;
                continue;
            }
        }
        packed.push(piece);
    }
    let mut merged: Vec<Piece> = Vec::with_capacity(packed.len());
    for piece in packed {
        if let Some(previous) = merged.last_mut() {
            if previous.chars < 200
                && previous.chars <= target_chars
                && piece.chars <= target_chars
                && previous.chars + piece.chars <= target_chars.max(1500)
            {
                previous.text.push_str(&piece.text);
                previous.chars += piece.chars;
                previous.atomic |= piece.atomic;
                continue;
            }
        }
        merged.push(piece);
    }
    merged
}

fn overlap_tail(text: &str, overlap_chars: usize) -> &str {
    let start = text
        .char_indices()
        .rev()
        .nth(overlap_chars.saturating_sub(1))
        .map(|(offset, _)| offset)
        .unwrap_or(0);
    if overlap_chars == 0 {
        return "";
    }
    let tail = &text[start..];
    if let Some((offset, character)) = tail.char_indices().find(|(_, character)| {
        matches!(character, '。' | '！' | '？' | '!' | '?' | '.' | ';' | '；')
    }) {
        let rest = tail[offset + character.len_utf8()..].trim_start();
        if !rest.is_empty() {
            return rest;
        }
    }
    if let Some((offset, character)) = tail
        .char_indices()
        .find(|(_, character)| character.is_whitespace())
    {
        let rest = &tail[offset + character.len_utf8()..];
        if !rest.is_empty() {
            return rest;
        }
    }
    tail
}
