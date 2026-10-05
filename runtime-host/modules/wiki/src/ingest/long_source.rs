use serde::{Deserialize, Serialize};

use super::text;

const LONG_SOURCE_CHUNK_MIN: usize = 12_000;
const LONG_SOURCE_CHUNK_MAX: usize = 60_000;
const LONG_SOURCE_DIGEST_MAX: usize = 15_000;
const LONG_SOURCE_CHUNK_ANALYSIS_MAX: usize = 40_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceChunk {
    pub id: String,
    pub index: usize,
    pub total: usize,
    pub heading_path: String,
    pub overlap_before: String,
    pub main: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongSourcePlan {
    pub chunked: bool,
    pub analysis: String,
    pub source_context: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_path: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongSourceCheckpoint {
    pub version: u8,
    pub source_identity: String,
    pub source_hash: String,
    pub source_length: usize,
    pub source_budget: usize,
    pub target_chars: usize,
    pub overlap_chars: usize,
    pub chunk_total: usize,
    pub completed_through: usize,
    pub global_digest: String,
    pub analyses: Vec<String>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LongSourceCheckpointParams {
    pub source_identity: String,
    pub source_hash: String,
    pub source_length: usize,
    pub source_budget: usize,
    pub target_chars: usize,
    pub overlap_chars: usize,
    pub chunk_total: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LongSourceChunkOutput {
    pub analysis_note: String,
    pub global_digest: String,
}

pub fn compute_long_source_target_chars(source_budget: usize) -> usize {
    clamp(
        source_budget * 55 / 100,
        LONG_SOURCE_CHUNK_MIN,
        LONG_SOURCE_CHUNK_MAX,
    )
}

pub fn compute_long_source_overlap_chars(target_chars: usize) -> usize {
    clamp(target_chars * 8 / 100, 800, 3_000)
}

pub fn split_source_into_semantic_chunks(
    content: &str,
    target_chars: usize,
    overlap_chars: usize,
) -> Vec<SourceChunk> {
    let target = target_chars.max(1_000);
    let blocks = semantic_blocks(content, target);
    if blocks.is_empty() {
        return Vec::new();
    }

    let mut raw_chunks = Vec::<RawChunk>::new();
    let mut current = Vec::<String>::new();
    let mut current_length = 0;
    let mut current_heading = blocks[0].heading_path.clone();

    for block in blocks {
        let block_len = text::len(&block.text);
        let next_length = current_length + block_len + usize::from(!current.is_empty()) * 2;
        if !current.is_empty() && next_length > target {
            push_raw_chunk(&mut raw_chunks, &mut current, &current_heading);
            current_length = 0;
        }
        if current.is_empty() {
            current_heading = block.heading_path;
        }
        current.push(block.text);
        current_length += block_len + usize::from(current.len() > 1) * 2;
    }
    push_raw_chunk(&mut raw_chunks, &mut current, &current_heading);

    let total = raw_chunks.len();
    raw_chunks
        .iter()
        .enumerate()
        .map(|(idx, chunk)| SourceChunk {
            id: format!("chunk-{}", idx + 1),
            index: idx + 1,
            total,
            heading_path: chunk.heading_path.clone(),
            overlap_before: if idx > 0 {
                overlap_suffix(&raw_chunks[idx - 1].main, overlap_chars)
            } else {
                String::new()
            },
            main: chunk.main.clone(),
        })
        .collect()
}

pub fn extract_marked_section(raw: &str, heading: &str) -> String {
    let mut lines = raw.split('\n');
    while let Some(line) = lines.next() {
        if !is_marked_section_heading(line, heading) {
            continue;
        }

        let mut body = Vec::new();
        for line in lines {
            if is_any_marked_section_heading(line) {
                break;
            }
            body.push(line);
        }
        return body.join("\n").trim().to_owned();
    }
    String::new()
}

pub fn hash_text_hex(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for code_unit in text.encode_utf16() {
        hash ^= u64::from(code_unit);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn long_source_checkpoint_path(
    project_path: &str,
    source_summary_slug: &str,
    source_hash: &str,
) -> String {
    format!(
        "{}/.llm-wiki/ingest-progress/{}-{}.json",
        normalize_slashes(project_path),
        source_summary_slug,
        source_hash
    )
}

pub fn is_compatible_long_source_checkpoint(
    checkpoint: &LongSourceCheckpoint,
    params: &LongSourceCheckpointParams,
) -> bool {
    checkpoint.version == 1
        && checkpoint.source_identity == params.source_identity
        && checkpoint.source_hash == params.source_hash
        && checkpoint.source_length == params.source_length
        && checkpoint.source_budget == params.source_budget
        && checkpoint.target_chars == params.target_chars
        && checkpoint.overlap_chars == params.overlap_chars
        && checkpoint.chunk_total == params.chunk_total
        && checkpoint.completed_through <= params.chunk_total
        && checkpoint.analyses.len() == checkpoint.completed_through
}

pub fn parse_compatible_long_source_checkpoint(
    raw: &str,
    params: &LongSourceCheckpointParams,
) -> Option<LongSourceCheckpoint> {
    let checkpoint = serde_json::from_str::<LongSourceCheckpoint>(raw).ok()?;
    is_compatible_long_source_checkpoint(&checkpoint, params).then_some(checkpoint)
}

pub fn serialize_long_source_checkpoint(
    checkpoint: &LongSourceCheckpoint,
) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(checkpoint)
}

pub fn long_source_checkpoint_params(
    source_identity: impl Into<String>,
    source_content: &str,
    source_budget: usize,
    target_chars: usize,
    overlap_chars: usize,
    chunk_total: usize,
) -> LongSourceCheckpointParams {
    LongSourceCheckpointParams {
        source_identity: source_identity.into(),
        source_hash: hash_text_hex(source_content),
        source_length: text::len(source_content),
        source_budget,
        target_chars,
        overlap_chars,
        chunk_total,
    }
}

pub fn next_long_source_checkpoint(
    params: &LongSourceCheckpointParams,
    completed_through: usize,
    global_digest: String,
    analyses: Vec<String>,
    updated_at: u64,
) -> LongSourceCheckpoint {
    LongSourceCheckpoint {
        version: 1,
        source_identity: params.source_identity.clone(),
        source_hash: params.source_hash.clone(),
        source_length: params.source_length,
        source_budget: params.source_budget,
        target_chars: params.target_chars,
        overlap_chars: params.overlap_chars,
        chunk_total: params.chunk_total,
        completed_through,
        global_digest,
        analyses,
        updated_at,
    }
}

pub fn long_source_chunk_output(
    raw: &str,
    chunk: &SourceChunk,
    global_digest: &str,
) -> LongSourceChunkOutput {
    let chunk_analysis = first_non_empty(&[
        extract_marked_section(raw, "Chunk Analysis"),
        raw.trim().to_owned(),
    ]);
    let next_digest = extract_marked_section(raw, "Updated Global Digest");
    let analysis_note = format!(
        "## Chunk {}/{}{}\n{}",
        chunk.index,
        chunk.total,
        if chunk.heading_path.is_empty() {
            String::new()
        } else {
            format!(" — {}", chunk.heading_path)
        },
        trim_long_text(&chunk_analysis, LONG_SOURCE_CHUNK_ANALYSIS_MAX)
    );
    let digest_source =
        first_non_empty(&[next_digest, join_non_empty(global_digest, &chunk_analysis)]);
    LongSourceChunkOutput {
        analysis_note,
        global_digest: trim_long_text(&digest_source, LONG_SOURCE_DIGEST_MAX),
    }
}

pub fn consolidated_long_source_analysis(global_digest: &str, analyses: &[String]) -> String {
    [
        "# Consolidated Long-Document Analysis".to_owned(),
        String::new(),
        "## Final Global Digest".to_owned(),
        if global_digest.is_empty() {
            "(No digest produced.)".to_owned()
        } else {
            global_digest.to_owned()
        },
        String::new(),
        "## Per-Chunk Analyses".to_owned(),
        analyses.join("\n\n"),
    ]
    .join("\n")
}

pub fn consolidated_long_source_context(
    source_identity: &str,
    chunk_total: usize,
    global_digest: &str,
    analyses: &[String],
    source_budget: usize,
) -> String {
    [
        format!("# Long Source Context: {source_identity}"),
        String::new(),
        format!("The original source was analyzed in {chunk_total} semantic chunks with paragraph/section boundaries and overlap. Use this consolidated context instead of assuming the raw document ended early."),
        String::new(),
        "## Final Global Digest".to_owned(),
        if global_digest.is_empty() {
            "(No digest produced.)".to_owned()
        } else {
            global_digest.to_owned()
        },
        String::new(),
        "## Chunk Analysis Notes".to_owned(),
        trim_long_text(&analyses.join("\n\n"), source_budget.max(LONG_SOURCE_CHUNK_ANALYSIS_MAX)),
    ]
    .join("\n")
}

pub fn completed_long_source_plan(
    source_identity: &str,
    chunk_total: usize,
    source_budget: usize,
    global_digest: &str,
    analyses: &[String],
    checkpoint_path: String,
) -> LongSourcePlan {
    LongSourcePlan {
        chunked: true,
        analysis: consolidated_long_source_analysis(global_digest, analyses),
        source_context: consolidated_long_source_context(
            source_identity,
            chunk_total,
            global_digest,
            analyses,
            source_budget,
        ),
        checkpoint_path: Some(checkpoint_path),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SemanticBlock {
    text: String,
    heading_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RawChunk {
    main: String,
    heading_path: String,
}

fn semantic_blocks(content: &str, target_chars: usize) -> Vec<SemanticBlock> {
    let mut blocks = Vec::new();
    let mut heading_stack = Vec::<String>::new();
    let mut paragraph = Vec::<String>::new();
    let mut paragraph_heading = String::new();
    let normalized = content.replace("\r\n", "\n");

    for line in normalized.split('\n') {
        if let Some((depth, title)) = parse_markdown_heading(line) {
            flush_paragraph(
                &mut blocks,
                &mut paragraph,
                &paragraph_heading,
                target_chars,
            );
            heading_stack.truncate(depth.saturating_sub(1));
            if heading_stack.len() < depth {
                heading_stack.resize(depth, String::new());
            }
            heading_stack[depth - 1] = title;
            let heading_path = heading_path(&heading_stack);
            blocks.push(SemanticBlock {
                text: line.trim().to_owned(),
                heading_path: heading_path.clone(),
            });
            paragraph_heading = heading_path;
            continue;
        }

        if line.trim().is_empty() {
            flush_paragraph(
                &mut blocks,
                &mut paragraph,
                &paragraph_heading,
                target_chars,
            );
            paragraph_heading = heading_path(&heading_stack);
            continue;
        }

        if paragraph.is_empty() {
            paragraph_heading = heading_path(&heading_stack);
        }
        paragraph.push(line.to_owned());
    }
    flush_paragraph(
        &mut blocks,
        &mut paragraph,
        &paragraph_heading,
        target_chars,
    );

    blocks
}

fn flush_paragraph(
    blocks: &mut Vec<SemanticBlock>,
    paragraph: &mut Vec<String>,
    paragraph_heading: &str,
    target_chars: usize,
) {
    let text = paragraph.join("\n").trim().to_owned();
    if !text.is_empty() {
        for piece in split_oversized_block(&text, target_chars) {
            blocks.push(SemanticBlock {
                text: piece,
                heading_path: paragraph_heading.to_owned(),
            });
        }
    }
    paragraph.clear();
}

fn split_oversized_block(block: &str, target_chars: usize) -> Vec<String> {
    if text::len(block) * 4 <= target_chars * 5 {
        return vec![block.to_owned()];
    }

    let mut out = Vec::new();
    let mut current = String::new();
    let mut current_length = 0;
    for piece in sentence_like_pieces(block) {
        let piece_length = text::len(piece);
        if !current.is_empty() && current_length + piece_length > target_chars {
            push_trimmed(&mut out, &current);
            current.clear();
            current_length = 0;
        }
        if piece_length > target_chars {
            let mut rest = piece;
            while !rest.is_empty() {
                let slice = text::prefix(rest, target_chars);
                push_trimmed(&mut out, slice);
                rest = &rest[slice.len()..];
            }
        } else {
            current.push_str(piece);
            current_length += piece_length;
        }
    }
    push_trimmed(&mut out, &current);
    out
}

fn sentence_like_pieces(block: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut chars = block.char_indices().peekable();
    let mut start = 0;
    while let Some((index, character)) = chars.next() {
        if character == '\n' {
            if start < index {
                pieces.push(&block[start..index]);
            }
            let mut end = index + 1;
            while chars.peek().is_some_and(|(_, character)| *character == '\n') {
                end = chars.next().unwrap().0 + 1;
            }
            pieces.push(&block[index..end]);
            start = end;
        } else if is_sentence_punctuation(character) {
            let end = index + character.len_utf8();
            pieces.push(&block[start..end]);
            start = end;
        }
    }
    if start < block.len() {
        pieces.push(&block[start..]);
    }
    pieces
}

fn overlap_suffix(text: &str, max_chars: usize) -> String {
    let raw = text::suffix(text, max_chars);
    if raw.len() == text.len() {
        return text.to_owned();
    }
    if let Some(paragraph_break) = first_paragraph_break(raw) {
        if paragraph_break > 0 && text::len(&raw[paragraph_break..]) > max_chars * 4 / 10 {
            return raw[paragraph_break..].trim().to_owned();
        }
    }
    if let Some((sentence_break, sentence_end)) = first_sentence_break(raw) {
        if sentence_break > 0 && text::len(&raw[sentence_break..]) > max_chars * 4 / 10 {
            return raw[sentence_end..].trim().to_owned();
        }
    }
    raw.trim().to_owned()
}

fn push_raw_chunk(raw_chunks: &mut Vec<RawChunk>, current: &mut Vec<String>, heading_path: &str) {
    let main = current.join("\n\n").trim().to_owned();
    if !main.is_empty() {
        raw_chunks.push(RawChunk {
            main,
            heading_path: heading_path.to_owned(),
        });
    }
    current.clear();
}

fn trim_long_text(text: &str, max_chars: usize) -> String {
    let prefix = text::prefix(text, max_chars);
    if prefix.len() == text.len() {
        return text.to_owned();
    }
    format!(
        "{}\n\n[...trimmed for prompt budget...]",
        prefix.trim_end()
    )
}

fn parse_markdown_heading(line: &str) -> Option<(usize, String)> {
    let mut depth = 0;
    for byte in line.bytes() {
        if byte == b'#' && depth < 6 {
            depth += 1;
        } else {
            break;
        }
    }
    if depth == 0
        || line
            .as_bytes()
            .get(depth)
            .is_none_or(|byte| !byte.is_ascii_whitespace())
    {
        return None;
    }
    let title = line[depth..].trim();
    (!title.is_empty()).then(|| (depth, title.to_owned()))
}

fn heading_path(stack: &[String]) -> String {
    stack
        .iter()
        .filter(|part| !part.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" > ")
}

fn is_marked_section_heading(line: &str, heading: &str) -> bool {
    let Some(title) = marked_section_title(line) else {
        return false;
    };
    title.eq_ignore_ascii_case(heading)
}

fn is_any_marked_section_heading(line: &str) -> bool {
    marked_section_title(line).is_some()
}

fn marked_section_title(line: &str) -> Option<&str> {
    let trimmed = line.trim_end();
    let rest = trimmed.strip_prefix("##")?;
    if rest
        .as_bytes()
        .first()
        .is_none_or(|byte| !byte.is_ascii_whitespace())
    {
        return None;
    }
    Some(rest.trim())
}

fn first_non_empty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_default()
}

fn join_non_empty(left: &str, right: &str) -> String {
    [left, right]
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn normalize_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

fn push_trimmed(out: &mut Vec<String>, text: &str) {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        out.push(trimmed.to_owned());
    }
}

fn clamp(value: usize, min: usize, max: usize) -> usize {
    value.max(min).min(max)
}

fn first_paragraph_break(text: &str) -> Option<usize> {
    let mut chars = text.char_indices().peekable();
    while let Some((index, character)) = chars.next() {
        if character != '\n' {
            continue;
        }
        while chars.peek().is_some_and(|(_, character)| {
            character.is_whitespace() && *character != '\n'
        }) {
            chars.next();
        }
        if chars.peek().is_some_and(|(_, character)| *character == '\n') {
            return Some(index);
        }
    }
    None
}

fn first_sentence_break(text: &str) -> Option<(usize, usize)> {
    let mut chars = text.char_indices().peekable();
    while let Some((index, character)) = chars.next() {
        if is_sentence_punctuation(character)
            && chars.peek().is_some_and(|(_, next)| next.is_whitespace())
        {
            return Some((index, index + character.len_utf8()));
        }
    }
    None
}

fn is_sentence_punctuation(char: char) -> bool {
    matches!(char, '.' | '!' | '?' | '。' | '！' | '？')
}
