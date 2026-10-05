mod language;
pub(crate) mod long_source;
pub(crate) mod parser;
pub(crate) mod prompts;
mod text;
pub(crate) mod write;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use chrono::Local;
use tokio_util::sync::CancellationToken;

use crate::{
    application::commands::WikiParsedImportSource,
    domain::{WikiFailure, WikiGeneratedPageInput, WikiReviewItem, now_ms},
    ports::{
        WikiIngestLlm, WikiIngestLlmMessage, WikiIngestLlmModelLimits, WikiIngestLlmOptions,
        WikiIngestLlmRequest, WikiIngestLlmRole,
    },
};

pub(crate) struct GeneratedImportPages {
    pub(crate) files: Vec<WikiGeneratedPageInput>,
    pub(crate) reviews: Vec<WikiReviewItem>,
    pub(crate) source_analysis: String,
    pub(crate) checkpoint_path: Option<PathBuf>,
}

pub(crate) async fn generate_imported_pages(
    llm: Option<Arc<dyn WikiIngestLlm>>,
    root: &Path,
    input: &WikiParsedImportSource,
    output_language: Option<&str>,
    generation_model_ref: Option<&str>,
    cancellation: CancellationToken,
    progress: &(dyn Fn(&str, Option<(usize, usize)>) -> Result<(), WikiFailure> + Send + Sync),
) -> Result<Option<GeneratedImportPages>, WikiFailure> {
    let Some(llm) = llm else {
        return Ok(None);
    };

    let context = ProjectIngestContext::read(root)?;
    let model_limits = llm
        .model_limits(generation_model_ref)
        .await?
        .unwrap_or_default();
    let model_context_tokens = model_limits.context_window.and_then(u64_to_usize);
    // Character packing keeps the existing numeric cap; this is not token conversion.
    let character_budget_cap = model_context_tokens;
    let stable_context_len = text::len(&context.purpose)
        + text::len(&context.schema)
        + text::len(&context.index)
        + text::len(&context.overview);
    let source_budget =
        prompts::compute_ingest_source_budget(character_budget_cap, stable_context_len);
    let generation_tokens = output_token_budget(
        prompts::compute_ingest_generation_max_tokens(model_context_tokens),
        model_limits,
    );
    let review_tokens = output_token_budget(
        prompts::compute_ingest_review_max_tokens(model_context_tokens),
        model_limits,
    );
    let today = Local::now().format("%Y-%m-%d").to_string();

    let source = prepare_source_context(
        llm.clone(),
        root,
        input,
        &context,
        source_budget,
        review_tokens,
        output_language,
        generation_model_ref,
        cancellation.clone(),
        progress,
    )
    .await?;
    let generation = generate_file_blocks(
        llm.clone(),
        input,
        &context,
        &source,
        generation_tokens,
        output_language,
        generation_model_ref,
        &today,
        cancellation.clone(),
        progress,
    )
    .await?;
    let (files, reviews) = parse_repair_and_review(
        llm,
        input,
        &context,
        &source,
        generation,
        generation_tokens,
        review_tokens,
        character_budget_cap,
        output_language,
        generation_model_ref,
        cancellation,
        progress,
    )
    .await?;

    Ok(Some(GeneratedImportPages {
        files,
        reviews,
        source_analysis: source.analysis,
        checkpoint_path: source.checkpoint_path,
    }))
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ProjectIngestContext {
    purpose: String,
    schema: String,
    index: String,
    overview: String,
}

impl ProjectIngestContext {
    fn read(root: &Path) -> Result<Self, WikiFailure> {
        Ok(Self {
            purpose: read_optional_text(root.join("purpose.md"))?,
            schema: read_optional_text(root.join("schema.md"))?,
            index: read_optional_text(root.join("wiki/index.md"))?,
            overview: read_optional_text(root.join("wiki/overview.md"))?,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PreparedSourceContext {
    analysis: String,
    source_context: String,
    checkpoint_path: Option<PathBuf>,
}

async fn prepare_source_context(
    llm: Arc<dyn WikiIngestLlm>,
    root: &Path,
    input: &WikiParsedImportSource,
    context: &ProjectIngestContext,
    source_budget: usize,
    review_tokens: u32,
    output_language: Option<&str>,
    generation_model_ref: Option<&str>,
    cancellation: CancellationToken,
    progress: &(dyn Fn(&str, Option<(usize, usize)>) -> Result<(), WikiFailure> + Send + Sync),
) -> Result<PreparedSourceContext, WikiFailure> {
    if text::len(&input.text) > source_budget {
        prepare_long_source_context(
            llm,
            root,
            input,
            context,
            source_budget,
            review_tokens,
            output_language,
            generation_model_ref,
            cancellation,
            progress,
        )
        .await
    } else {
        prepare_single_source_context(
            llm,
            input,
            context,
            review_tokens,
            output_language,
            generation_model_ref,
            cancellation,
            progress,
        )
        .await
    }
}

async fn prepare_single_source_context(
    llm: Arc<dyn WikiIngestLlm>,
    input: &WikiParsedImportSource,
    context: &ProjectIngestContext,
    review_tokens: u32,
    output_language: Option<&str>,
    generation_model_ref: Option<&str>,
    cancellation: CancellationToken,
    progress: &(dyn Fn(&str, Option<(usize, usize)>) -> Result<(), WikiFailure> + Send + Sync),
) -> Result<PreparedSourceContext, WikiFailure> {
    let source_context = input.text.clone();
    let analysis_prompt = prompts::build_analysis_prompt(prompts::AnalysisPromptParams {
        purpose: &context.purpose,
        index: &context.index,
        source_content: &source_context,
        schema: &context.schema,
        output_language,
    });
    progress("analyze", None)?;
    let analysis = ask_llm(
        &llm,
        vec![
            WikiIngestLlmMessage {
                role: WikiIngestLlmRole::System,
                content: analysis_prompt,
            },
            WikiIngestLlmMessage {
                role: WikiIngestLlmRole::User,
                content: format!(
                    "Analyze this source document:\n\n**File:** {}{}\n\n---\n\n{}",
                    input.staged.source_identity,
                    folder_context(&input.staged.source_identity)
                        .map(|folder| format!("\n**Folder context:** {folder}"))
                        .unwrap_or_default(),
                    source_context
                ),
            },
        ],
        review_tokens,
        generation_model_ref,
        cancellation,
    )
    .await?;

    Ok(PreparedSourceContext {
        analysis,
        source_context,
        checkpoint_path: None,
    })
}

async fn prepare_long_source_context(
    llm: Arc<dyn WikiIngestLlm>,
    root: &Path,
    input: &WikiParsedImportSource,
    context: &ProjectIngestContext,
    source_budget: usize,
    review_tokens: u32,
    output_language: Option<&str>,
    generation_model_ref: Option<&str>,
    cancellation: CancellationToken,
    progress: &(dyn Fn(&str, Option<(usize, usize)>) -> Result<(), WikiFailure> + Send + Sync),
) -> Result<PreparedSourceContext, WikiFailure> {
    let target_chars = long_source::compute_long_source_target_chars(source_budget);
    let overlap_chars = long_source::compute_long_source_overlap_chars(target_chars);
    let chunks =
        long_source::split_source_into_semantic_chunks(&input.text, target_chars, overlap_chars);
    if chunks.len() <= 1 {
        return prepare_single_source_context(
            llm,
            input,
            context,
            review_tokens,
            output_language,
            generation_model_ref,
            cancellation,
            progress,
        )
        .await;
    }

    let source_hash = long_source::hash_text_hex(&input.text);
    let checkpoint_path = PathBuf::from(long_source::long_source_checkpoint_path(
        &path_text(root),
        source_summary_slug(&input.staged.page_relative_path),
        &source_hash,
    ));
    let params = long_source::long_source_checkpoint_params(
        input.staged.source_identity.clone(),
        &input.text,
        source_budget,
        target_chars,
        overlap_chars,
        chunks.len(),
    );
    let checkpoint = std::fs::read_to_string(&checkpoint_path)
        .ok()
        .and_then(|raw| long_source::parse_compatible_long_source_checkpoint(&raw, &params));
    let mut completed_through = checkpoint
        .as_ref()
        .map(|checkpoint| checkpoint.completed_through)
        .unwrap_or(0);
    let mut global_digest = checkpoint
        .as_ref()
        .map(|checkpoint| checkpoint.global_digest.clone())
        .unwrap_or_default();
    let mut analyses = checkpoint
        .map(|checkpoint| checkpoint.analyses)
        .unwrap_or_default();

    let system_prompt =
        prompts::build_chunk_analysis_system_prompt(prompts::ChunkAnalysisSystemPromptParams {
            purpose: &context.purpose,
            schema: &context.schema,
            index: &context.index,
            source_content: &input.text,
            output_language,
        });

    progress("analyze", Some((completed_through, chunks.len())))?;
    for chunk in chunks.iter().skip(completed_through) {
        let user_prompt =
            prompts::build_chunk_analysis_user_prompt(prompts::ChunkAnalysisUserPromptParams {
                source_identity: &input.staged.source_identity,
                folder_context: folder_context(&input.staged.source_identity).as_deref(),
                chunk: prompts::SourceChunk {
                    id: &chunk.id,
                    index: chunk.index,
                    total: chunk.total,
                    heading_path: &chunk.heading_path,
                    overlap_before: &chunk.overlap_before,
                    main: &chunk.main,
                },
                global_digest: &global_digest,
            });
        let raw = ask_llm(
            &llm,
            vec![
                WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::System,
                    content: system_prompt.clone(),
                },
                WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::User,
                    content: user_prompt,
                },
            ],
            review_tokens,
            generation_model_ref,
            cancellation.clone(),
        )
        .await?;
        let output = long_source::long_source_chunk_output(&raw, chunk, &global_digest);
        analyses.push(output.analysis_note);
        global_digest = output.global_digest;
        completed_through = chunk.index;
        write_checkpoint(
            &checkpoint_path,
            &long_source::next_long_source_checkpoint(
                &params,
                completed_through,
                global_digest.clone(),
                analyses.clone(),
                now_ms(),
            ),
        )?;
        progress("analyze", Some((completed_through, chunks.len())))?;
    }

    let plan = long_source::completed_long_source_plan(
        &input.staged.source_identity,
        chunks.len(),
        source_budget,
        &global_digest,
        &analyses,
        path_text(&checkpoint_path),
    );
    Ok(PreparedSourceContext {
        analysis: plan.analysis,
        source_context: plan.source_context,
        checkpoint_path: plan.checkpoint_path.map(PathBuf::from),
    })
}

async fn generate_file_blocks(
    llm: Arc<dyn WikiIngestLlm>,
    input: &WikiParsedImportSource,
    context: &ProjectIngestContext,
    source: &PreparedSourceContext,
    max_tokens: u32,
    output_language: Option<&str>,
    generation_model_ref: Option<&str>,
    today: &str,
    cancellation: CancellationToken,
    progress: &(dyn Fn(&str, Option<(usize, usize)>) -> Result<(), WikiFailure> + Send + Sync),
) -> Result<String, WikiFailure> {
    let generation_prompt = prompts::build_generation_prompt(prompts::GenerationPromptParams {
        schema: &context.schema,
        purpose: &context.purpose,
        index: &context.index,
        source_identity: &input.staged.source_identity,
        overview: &context.overview,
        source_content: &source.source_context,
        source_summary_path: Some(&input.staged.page_relative_path),
        output_language,
        today,
    });
    progress("generate", None)?;
    ask_llm(
        &llm,
        vec![
            WikiIngestLlmMessage {
                role: WikiIngestLlmRole::System,
                content: generation_prompt,
            },
            WikiIngestLlmMessage {
                role: WikiIngestLlmRole::User,
                content: format!(
                    "Source document to process: **{}**\n\nThe Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo\nits tables, bullet points, or prose. Your output must be FILE/REVIEW\nblocks as specified in the system prompt — nothing else.\n\n## Stage 1 Analysis (context only — do not repeat)\n\n{}\n\n## Source Context\n\n{}\n\n---\n\nNow emit the FILE blocks for the wiki files derived from **{}**.\nYour response MUST begin with `---FILE:` as the very first characters.\nNo preamble. No analysis prose. Start immediately.",
                    input.staged.source_identity,
                    source.analysis,
                    source.source_context,
                    input.staged.source_identity
                ),
            },
        ],
        max_tokens,
        generation_model_ref,
        cancellation,
    )
    .await
}

async fn parse_repair_and_review(
    llm: Arc<dyn WikiIngestLlm>,
    input: &WikiParsedImportSource,
    context: &ProjectIngestContext,
    source: &PreparedSourceContext,
    generation: String,
    generation_tokens: u32,
    review_tokens: u32,
    max_context_size: Option<usize>,
    output_language: Option<&str>,
    generation_model_ref: Option<&str>,
    cancellation: CancellationToken,
    progress: &(dyn Fn(&str, Option<(usize, usize)>) -> Result<(), WikiFailure> + Send + Sync),
) -> Result<(Vec<WikiGeneratedPageInput>, Vec<WikiReviewItem>), WikiFailure> {
    let mut parsed = parser::parse_file_blocks(&generation);
    if !parsed.truncated_paths.is_empty() {
        let paths = parsed
            .truncated_paths
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let repair_prompt =
            prompts::build_truncated_file_repair_prompt(prompts::TruncatedFileRepairPromptParams {
                paths: &paths,
                source_identity: &input.staged.source_identity,
                context: prompts::TruncatedFileRepairContext {
                    schema: &context.schema,
                    purpose: &context.purpose,
                    analysis: &source.analysis,
                    source_context: &source.source_context,
                    max_context_size,
                },
                output_language,
            });
        progress("repair", None)?;
        let repair = ask_llm(
            &llm,
            vec![
                WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::System,
                    content: repair_prompt,
                },
                WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::User,
                    content: "Regenerate the requested FILE blocks now. Start immediately with `---FILE:`.".to_owned(),
                },
            ],
            generation_tokens,
            generation_model_ref,
            cancellation.clone(),
        )
        .await?;
        let requested = parsed.truncated_paths.clone();
        let (filtered, repaired_paths, _) =
            parser::filter_truncated_file_repair_output(&repair, &requested);
        parsed
            .blocks
            .extend(parser::parse_file_blocks(&filtered).blocks);
        let missing = requested
            .into_iter()
            .filter(|path| !repaired_paths.iter().any(|repaired| repaired == path))
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(WikiFailure::invalid_input(
                "generation",
                format!(
                    "wiki ingest could not repair truncated FILE blocks: {}",
                    missing.join(", ")
                ),
            ));
        }
    }

    let files = parsed
        .blocks
        .into_iter()
        .map(|block| WikiGeneratedPageInput {
            path: block.path,
            content: block.content,
        })
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Err(WikiFailure::invalid_input(
            "generation",
            "wiki ingest did not produce any FILE blocks",
        ));
    }

    let mut reviews = parser::parse_review_blocks(&generation, &input.staged.source_relative_path);
    if parser::should_run_dedicated_review_stage(&generation) {
        progress("review", None)?;
        match generate_review_suggestions(
            llm,
            input,
            context,
            source,
            &generation,
            review_tokens,
            max_context_size,
            output_language,
            generation_model_ref,
            cancellation,
        )
        .await
        {
            Ok(review_output) => reviews.extend(parser::parse_review_blocks(
                &review_output,
                &input.staged.source_relative_path,
            )),
            Err(error) if error.is_cancelled() => return Err(error),
            Err(_) => {}
        }
    }

    Ok((files, reviews))
}

async fn generate_review_suggestions(
    llm: Arc<dyn WikiIngestLlm>,
    input: &WikiParsedImportSource,
    context: &ProjectIngestContext,
    source: &PreparedSourceContext,
    generation: &str,
    review_tokens: u32,
    max_context_size: Option<usize>,
    output_language: Option<&str>,
    generation_model_ref: Option<&str>,
    cancellation: CancellationToken,
) -> Result<String, WikiFailure> {
    let prompt = prompts::build_review_suggestion_prompt(prompts::ReviewSuggestionPromptParams {
        purpose: &context.purpose,
        index: &context.index,
        source_identity: &input.staged.source_identity,
        analysis: &source.analysis,
        source_context: &source.source_context,
        generation,
        max_context_size,
        output_language,
    });
    llm.generate_cancellable(
        WikiIngestLlmRequest {
            model_ref: generation_model_ref.map(str::to_owned),
            messages: vec![
                WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::System,
                    content: prompt,
                },
                WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::User,
                    content: "Emit only high-value REVIEW blocks for follow-up research or unresolved knowledge gaps. Output nothing if there are none.".to_owned(),
                },
            ],
            options: WikiIngestLlmOptions {
                max_output_tokens: Some(review_tokens),
                temperature: Some(0.1),
            },
        },
        cancellation,
    )
    .await
    .map(|response| response.text)
}

async fn ask_llm(
    llm: &Arc<dyn WikiIngestLlm>,
    messages: Vec<WikiIngestLlmMessage>,
    max_output_tokens: u32,
    generation_model_ref: Option<&str>,
    cancellation: CancellationToken,
) -> Result<String, WikiFailure> {
    llm.generate_cancellable(
        WikiIngestLlmRequest {
            model_ref: generation_model_ref.map(str::to_owned),
            messages,
            options: WikiIngestLlmOptions {
                max_output_tokens: Some(max_output_tokens),
                temperature: Some(0.1),
            },
        },
        cancellation,
    )
    .await
    .map(|response| response.text)
}

fn output_token_budget(target: usize, limits: WikiIngestLlmModelLimits) -> u32 {
    let capped = limits
        .max_tokens
        .and_then(u64_to_usize)
        .map_or(target, |max_tokens| target.min(max_tokens));
    capped.min(u32::MAX as usize) as u32
}

fn u64_to_usize(value: u64) -> Option<usize> {
    (value <= usize::MAX as u64).then_some(value as usize)
}

fn write_checkpoint(
    path: &Path,
    checkpoint: &long_source::LongSourceCheckpoint,
) -> Result<(), WikiFailure> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    let bytes = long_source::serialize_long_source_checkpoint(checkpoint).map_err(|error| {
        WikiFailure::state(format!("long source checkpoint encode failed: {error}"))
    })?;
    std::fs::write(path, bytes).map_err(|error| WikiFailure::io(path_text(path), error))
}

fn read_optional_text(path: PathBuf) -> Result<String, WikiFailure> {
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(WikiFailure::io(path_text(&path), error)),
    }
}

fn folder_context(source_identity: &str) -> Option<String> {
    source_identity
        .rsplit_once('/')
        .map(|(folder, _)| folder.replace('/', " > "))
        .filter(|folder| !folder.trim().is_empty())
}

fn source_summary_slug(page_relative_path: &str) -> &str {
    page_relative_path
        .strip_prefix("wiki/sources/")
        .and_then(|path| path.strip_suffix(".md"))
        .unwrap_or(page_relative_path)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
