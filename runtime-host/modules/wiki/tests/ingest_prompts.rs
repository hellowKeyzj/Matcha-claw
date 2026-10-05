#[path = "../src/ingest/language.rs"]
mod language;
#[path = "../src/ingest/prompts.rs"]
mod prompts;
#[path = "../src/ingest/text.rs"]
mod text;

use prompts::{
    AnalysisPromptParams, ChunkAnalysisSystemPromptParams, ChunkAnalysisUserPromptParams,
    GenerationPromptParams, SourceChunk, TruncatedFileRepairContext,
    TruncatedFileRepairPromptParams,
};

#[test]
fn generation_prompt_preserves_file_and_review_contract() {
    let prompt = prompts::build_generation_prompt(GenerationPromptParams {
        schema: "type: finding -> wiki/findings/",
        purpose: "Keep research evidence exact.",
        index: "- [[existing]]",
        source_identity: "raw/sources/paper.md",
        overview: "Current overview",
        source_content: "English source",
        source_summary_path: Some("wiki/sources/paper.md"),
        output_language: Some("English"),
        today: "2026-09-25",
    });

    assert!(
        prompt.contains("All wiki pages generated from this source MUST include this filename")
    );
    assert!(prompt.contains("Do not generate wiki/index.md or wiki/overview.md"));
    assert!(prompt.contains("---FILE: wiki/path/to/page.md---"));
    assert!(prompt.contains("---REVIEW: type | Title---"));
    assert!(prompt.contains("The FIRST character of your response MUST be `-`"));
    assert!(prompt.contains("Preserve subject boundaries"));
    assert!(prompt.contains("Preserve structured source data verbatim"));
    assert!(prompt.ends_with("proper-noun and technical-identifier preservation rule above."));
}

#[test]
fn analysis_review_repair_and_chunk_prompts_keep_critical_instructions() {
    let analysis = prompts::build_analysis_prompt(AnalysisPromptParams {
        purpose: "Purpose",
        index: "Index",
        source_content: "中文资料",
        schema: "Schema",
        output_language: None,
    });
    assert!(analysis.contains("## ⚠️ MANDATORY OUTPUT LANGUAGE: Chinese"));
    assert!(analysis.contains("Which named subject is each claim about?"));
    assert!(analysis.contains("If a folder context is provided"));

    let repair = prompts::build_truncated_file_repair_prompt(TruncatedFileRepairPromptParams {
        paths: &["wiki/a.md", "wiki/b.md"],
        source_identity: "source.md",
        context: TruncatedFileRepairContext {
            schema: "Schema",
            purpose: "Purpose",
            analysis: "Analysis",
            source_context: "Source context",
            max_context_size: Some(32_000),
        },
        output_language: Some("English"),
    });
    assert!(repair.contains(
        "Return exactly one complete FILE block for each requested path and no other files."
    ));
    assert!(repair.contains("Every block must end with `---END FILE---`"));
    assert!(repair.contains("- wiki/a.md"));
    assert!(repair.contains("Do not output a preamble, REVIEW blocks, or trailing commentary."));

    let review = prompts::build_review_suggestion_prompt(prompts::ReviewSuggestionPromptParams {
        purpose: "Purpose",
        index: "Index",
        source_identity: "source.md",
        analysis: "Analysis",
        source_context: "Source context",
        generation: "Generated FILE blocks",
        max_context_size: Some(32_000),
        output_language: Some("English"),
    });
    assert!(review.contains("high-value follow-up research items for a personal wiki"));
    assert!(review.contains("The wiki page generation already happened"));
    assert!(review.contains("unresolved knowledge gaps that deserve human attention"));
    assert!(review.contains("Return REVIEW blocks only. Do not output FILE blocks."));

    let chunk_system =
        prompts::build_chunk_analysis_system_prompt(ChunkAnalysisSystemPromptParams {
            purpose: "Purpose",
            schema: "Schema",
            index: "Index",
            source_content: "Source",
            output_language: Some("English"),
        });
    assert!(chunk_system.contains("Analyze only the current MAIN CHUNK"));
    assert!(chunk_system.contains("Output exactly two markdown sections"));
    assert!(chunk_system.contains("## Updated Global Digest"));

    let chunk_user = prompts::build_chunk_analysis_user_prompt(ChunkAnalysisUserPromptParams {
        source_identity: "source.md",
        folder_context: Some("papers/energy"),
        chunk: SourceChunk {
            id: "chunk-1",
            index: 1,
            total: 2,
            heading_path: "Intro",
            overlap_before: "previous overlap",
            main: "main chunk",
        },
        global_digest: "digest",
    });
    assert!(chunk_user.contains("## MAIN CHUNK TO ANALYZE"));
    assert!(chunk_user.contains("Return only the two requested sections."));
}

#[test]
fn auto_language_detection_covers_common_latin_languages() {
    assert!(
        prompts::language_rule(None, "Le modèle analyse les données avec précision.")
            .contains("French")
    );
    assert!(
        prompts::language_rule(None, "Der Bericht ist wichtig und mit Quellen belegt.")
            .contains("German")
    );
    assert!(
        prompts::language_rule(None, "El informe contiene datos para los equipos.")
            .contains("Spanish")
    );
    assert!(
        prompts::language_rule(None, "O relatório não muda para uma página nova.")
            .contains("Portuguese")
    );
    assert!(
        prompts::language_rule(None, "Il metodo che descrive questa ricerca con esempi.")
            .contains("Italian")
    );
}

#[test]
fn context_budget_matches_ingest_thresholds_and_trimming_marker() {
    assert_eq!(prompts::compute_context_budget(None).max_ctx, 204_800);
    assert_eq!(
        prompts::compute_ingest_generation_max_tokens(Some(128_000)),
        16_384
    );
    assert_eq!(
        prompts::compute_ingest_generation_max_tokens(Some(512_000)),
        32_768
    );
    assert_eq!(
        prompts::compute_ingest_review_max_tokens(Some(512_000)),
        8_192
    );
    assert!(prompts::compute_ingest_source_budget(Some(10_000), 1_000) >= 8_000);
    assert_eq!(
        prompts::trim_long_text("abcdef", 3),
        "abc\n\n[...trimmed for prompt budget...]"
    );
}

#[test]
fn page_merge_prompt_preserves_conflict_and_output_rules() {
    let prompt = prompts::build_page_merge_system_prompt();

    assert!(prompt.contains("Preserves every factual claim from both versions"));
    assert!(prompt.contains("Preserves subject/source boundaries"));
    assert!(prompt.contains("The FIRST character of your response MUST be `-`"));
    assert!(prompt.contains("Output the COMPLETE file: YAML frontmatter + body"));
}
