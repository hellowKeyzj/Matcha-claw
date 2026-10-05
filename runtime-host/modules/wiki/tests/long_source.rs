#[path = "../src/ingest/long_source.rs"]
mod long_source;
#[path = "../src/ingest/text.rs"]
mod text;

use long_source::{
    LongSourceCheckpoint, LongSourceCheckpointParams, extract_marked_section, hash_text_hex,
    is_compatible_long_source_checkpoint, long_source_checkpoint_path,
    split_source_into_semantic_chunks,
};

#[test]
fn splits_markdown_on_semantic_boundaries_with_overlap() {
    let source = "# Alpha\n\nFirst sentence. Second sentence.\n\n## Beta\n\nThird sentence. Fourth sentence.\n\n## Gamma\n\nFifth sentence.";
    let chunks = split_source_into_semantic_chunks(source, 1_000, 24);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].id, "chunk-1");
    assert_eq!(chunks[0].index, 1);
    assert_eq!(chunks[0].total, 1);
    assert_eq!(chunks[0].heading_path, "Alpha");
    assert!(chunks[0].main.contains("## Beta"));
}

#[test]
fn extracts_marked_section_until_next_h2() {
    let raw = "intro\n## Chunk Analysis\nA\nB\n## Updated Global Digest\nDigest";

    assert_eq!(extract_marked_section(raw, "chunk analysis"), "A\nB");
    assert_eq!(
        extract_marked_section(raw, "Updated Global Digest"),
        "Digest"
    );
    assert_eq!(extract_marked_section(raw, "Missing"), "");
}

#[test]
fn checkpoint_helpers_match_legacy_shape() {
    let source = "hello";
    let source_hash = hash_text_hex(source);
    let params = LongSourceCheckpointParams {
        source_identity: "raw/sources/a.md".to_owned(),
        source_hash: source_hash.clone(),
        source_length: 5,
        source_budget: 12_000,
        target_chars: 12_000,
        overlap_chars: 960,
        chunk_total: 2,
    };
    let checkpoint = LongSourceCheckpoint {
        version: 1,
        source_identity: params.source_identity.clone(),
        source_hash: source_hash.clone(),
        source_length: params.source_length,
        source_budget: params.source_budget,
        target_chars: params.target_chars,
        overlap_chars: params.overlap_chars,
        chunk_total: params.chunk_total,
        completed_through: 1,
        global_digest: "digest".to_owned(),
        analyses: vec!["a".to_owned()],
        updated_at: 7,
    };

    assert_eq!(source_hash, "a430d84680aabd0b");
    assert_eq!(
        long_source_checkpoint_path("C:\\project", "source-a", &source_hash),
        "C:/project/.llm-wiki/ingest-progress/source-a-a430d84680aabd0b.json"
    );
    assert!(is_compatible_long_source_checkpoint(&checkpoint, &params));

    let mut incompatible = checkpoint;
    incompatible.analyses.clear();
    assert!(!is_compatible_long_source_checkpoint(
        &incompatible,
        &params
    ));
}
