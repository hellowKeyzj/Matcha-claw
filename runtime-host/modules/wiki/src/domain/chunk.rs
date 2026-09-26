use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiChunk {
    chunk_id: String,
    ordinal: usize,
    text: String,
}

impl WikiChunk {
    pub fn new(chunk_id: String, ordinal: usize, text: String) -> Self {
        Self {
            chunk_id,
            ordinal,
            text,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

pub fn chunk_markdown(relative_path: &str, content: &str, max_chars: usize) -> Vec<WikiChunk> {
    let max_chars = max_chars.max(1);
    let mut chunks = Vec::new();
    let mut current = String::new();
    for paragraph in content.split("\n\n") {
        if !current.is_empty() && current.len() + paragraph.len() + 2 > max_chars {
            push_chunk(relative_path, &mut chunks, std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(paragraph.trim());
    }
    if !current.trim().is_empty() {
        push_chunk(relative_path, &mut chunks, current);
    }
    chunks
}

fn push_chunk(relative_path: &str, chunks: &mut Vec<WikiChunk>, text: String) {
    let ordinal = chunks.len();
    chunks.push(WikiChunk::new(
        format!("{relative_path}#{ordinal}"),
        ordinal,
        text,
    ));
}
