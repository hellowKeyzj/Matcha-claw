const DEFAULT_MAX_CTX: usize = 204_800;
const LONG_SOURCE_MIN_BUDGET: usize = 8_000;
const LONG_SOURCE_MAX_SINGLE_PASS_BUDGET: usize = 300_000;
const INGEST_GENERATION_TOKENS_DEFAULT: usize = 8_192;
const INGEST_GENERATION_TOKENS_128K: usize = 16_384;
const INGEST_GENERATION_TOKENS_256K: usize = 24_576;
const INGEST_GENERATION_TOKENS_512K: usize = 32_768;
const GENERATION_WIKI_TYPES: &[&str] = &[
    "source",
    "entity",
    "concept",
    "comparison",
    "query",
    "synthesis",
    "thesis",
    "methodology",
    "finding",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContextBudget {
    pub max_ctx: usize,
    pub response_reserve: usize,
    pub index_budget: usize,
    pub page_budget: usize,
    pub max_page_size: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AnalysisPromptParams<'a> {
    pub purpose: &'a str,
    pub index: &'a str,
    pub source_content: &'a str,
    pub schema: &'a str,
    pub output_language: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GenerationPromptParams<'a> {
    pub schema: &'a str,
    pub purpose: &'a str,
    pub index: &'a str,
    pub source_identity: &'a str,
    pub overview: &'a str,
    pub source_content: &'a str,
    pub source_summary_path: Option<&'a str>,
    pub output_language: Option<&'a str>,
    pub today: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TruncatedFileRepairContext<'a> {
    pub schema: &'a str,
    pub purpose: &'a str,
    pub analysis: &'a str,
    pub source_context: &'a str,
    pub max_context_size: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TruncatedFileRepairPromptParams<'a> {
    pub paths: &'a [&'a str],
    pub source_identity: &'a str,
    pub context: TruncatedFileRepairContext<'a>,
    pub output_language: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReviewSuggestionPromptParams<'a> {
    pub purpose: &'a str,
    pub schema: &'a str,
    pub index: &'a str,
    pub overview: &'a str,
    pub source_identity: &'a str,
    pub analysis: &'a str,
    pub source_context: &'a str,
    pub generation: &'a str,
    pub max_context_size: Option<usize>,
    pub output_language: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChunkAnalysisSystemPromptParams<'a> {
    pub purpose: &'a str,
    pub schema: &'a str,
    pub index: &'a str,
    pub source_content: &'a str,
    pub output_language: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceChunk<'a> {
    pub id: &'a str,
    pub index: usize,
    pub total: usize,
    pub heading_path: &'a str,
    pub overlap_before: &'a str,
    pub main: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChunkAnalysisUserPromptParams<'a> {
    pub source_identity: &'a str,
    pub folder_context: Option<&'a str>,
    pub chunk: SourceChunk<'a>,
    pub global_digest: &'a str,
}

pub fn compute_context_budget(max_context_size: Option<usize>) -> ContextBudget {
    let max_ctx = max_context_size
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_CTX);
    let response_reserve = max_ctx * 15 / 100;
    let index_budget = max_ctx * 5 / 100;
    let page_budget = max_ctx / 2;
    let max_page_size = page_budget.min(5_000.max(page_budget * 30 / 100));

    ContextBudget {
        max_ctx,
        response_reserve,
        index_budget,
        page_budget,
        max_page_size,
    }
}

pub fn compute_ingest_source_budget(
    max_context_size: Option<usize>,
    stable_context_length: usize,
) -> usize {
    let budget = compute_context_budget(max_context_size);
    let stable_reserve = (budget.max_ctx / 4).min(12_000.max(stable_context_length));
    let instruction_reserve = 12_000.max(budget.max_ctx * 8 / 100);
    let available = budget.max_ctx as isize
        - budget.response_reserve as isize
        - stable_reserve as isize
        - instruction_reserve as isize;
    let upper = LONG_SOURCE_MAX_SINGLE_PASS_BUDGET
        .min(LONG_SOURCE_MIN_BUDGET.max(budget.max_ctx * 60 / 100));
    clamp_usize(available, LONG_SOURCE_MIN_BUDGET, upper)
}

pub fn compute_ingest_generation_max_tokens(max_context_size: Option<usize>) -> usize {
    let max_ctx = compute_context_budget(max_context_size).max_ctx;
    if max_ctx >= 512_000 {
        INGEST_GENERATION_TOKENS_512K
    } else if max_ctx >= 256_000 {
        INGEST_GENERATION_TOKENS_256K
    } else if max_ctx >= 128_000 {
        INGEST_GENERATION_TOKENS_128K
    } else {
        INGEST_GENERATION_TOKENS_DEFAULT
    }
}

pub fn compute_ingest_review_max_tokens(max_context_size: Option<usize>) -> usize {
    (compute_ingest_generation_max_tokens(max_context_size) / 2).clamp(4_096, 8_192)
}

pub fn language_rule(output_language: Option<&str>, fallback_text: &str) -> String {
    let language =
        match output_language.filter(|language| !language.is_empty() && *language != "auto") {
            Some(language) => language.to_owned(),
            None => detect_language(if fallback_text.is_empty() {
                "English"
            } else {
                fallback_text
            }),
        };
    let prompt_language = language_prompt_name(&language);
    [
        format!("## ⚠️ MANDATORY OUTPUT LANGUAGE: {prompt_language}"),
        String::new(),
        format!("Write surrounding natural-language prose in **{prompt_language}**."),
        format!("All generated prose, including prose titles and section headings, must be in {prompt_language}."),
        "Do not translate, transliterate, or describe proper nouns and technical identifiers unless the source already uses a well-established localized form.".to_owned(),
        "Preserve organization names, product names, model names, dataset names, tool/library names, acronyms, code identifiers, file names, URLs, paper titles, citation strings, and technical terms that have no widely-used localized equivalent in their standard original form.".to_owned(),
        format!("The source material or wiki content may be in a different language; use it as evidence, but keep generated prose in {prompt_language}."),
        "This language rule overrides weaker style instructions, but it does not override the proper-noun and technical-identifier preservation rule above.".to_owned(),
    ]
    .join("\n")
}

pub fn build_analysis_prompt(params: AnalysisPromptParams<'_>) -> String {
    join_non_empty(vec![
        "You are an expert research analyst. Read the source document and produce a structured analysis.".to_owned(),
        "Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.".to_owned(),
        language_rule(params.output_language, params.source_content),
        "Your analysis should cover:".to_owned(),
        "## Key Entities".to_owned(),
        "List people, organizations, products, datasets, tools mentioned. For each:".to_owned(),
        "- Name and type".to_owned(),
        "- Role in the source (central vs. peripheral)".to_owned(),
        "- Whether it likely already exists in the wiki (check the index)".to_owned(),
        "## Key Concepts".to_owned(),
        "List theories, methods, techniques, phenomena. For each:".to_owned(),
        "- Name and brief definition".to_owned(),
        "- Why it matters in this source".to_owned(),
        "- Whether it likely already exists in the wiki".to_owned(),
        "## Main Arguments & Findings".to_owned(),
        "- What are the core claims or results?".to_owned(),
        "- What evidence supports them?".to_owned(),
        "- How strong is the evidence?".to_owned(),
        "- Which named subject is each claim about? Do not transfer claims, limits, or evaluations from one entity/model/product/method to another just because they share keywords.".to_owned(),
        "- Preserve structured source data verbatim in the analysis when present: include SQL DDL / CREATE TABLE statements, schema definitions, API signatures, configuration, and tables in fenced code blocks or Markdown tables. Do not reduce exact field names, types, constraints, keys, or indexes to prose.".to_owned(),
        "## Connections to Existing Wiki".to_owned(),
        "- What existing pages does this source relate to?".to_owned(),
        "- Does it strengthen, challenge, or extend existing knowledge?".to_owned(),
        "## Contradictions & Tensions".to_owned(),
        "- Does anything in this source conflict with existing wiki content?".to_owned(),
        "- Are there internal tensions or caveats?".to_owned(),
        "## Recommendations".to_owned(),
        "- What wiki pages should be created or updated?".to_owned(),
        "- If the project schema (below) defines page types beyond entity/concept (e.g. goal, habit, reflection, finding, decision, meeting), and the source genuinely contains matching content, recommend pages of those types — name the type explicitly. Only when the source actually supports it; never invent goals/habits/journal entries that aren't in the source.".to_owned(),
        "- What should be emphasized vs. de-emphasized?".to_owned(),
        "- Any open questions worth flagging for the user?".to_owned(),
        "Be thorough but concise. Focus on what's genuinely important.".to_owned(),
        "If a folder context is provided, use it as a hint for categorization — the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).".to_owned(),
        optional_section(
            !params.schema.is_empty(),
            format!("## Project Schema (page types available — map source content to schema-defined types when it fits)\n{}", params.schema),
        ),
        optional_section(
            !params.purpose.is_empty(),
            format!("## Wiki Purpose (for context)\n{}", params.purpose),
        ),
        optional_section(
            !params.index.is_empty(),
            format!("## Current Wiki Index (for checking existing content)\n{}", params.index),
        ),
    ])
}

pub fn build_generation_prompt(params: GenerationPromptParams<'_>) -> String {
    let summary_path = params
        .source_summary_path
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "wiki/sources/{}.md",
                strip_extension(params.source_identity)
            )
        });
    let known_types = GENERATION_WIKI_TYPES.join(" | ");

    join_non_empty(vec![
        "You are a wiki maintainer. Based on the analysis provided, generate wiki files.".to_owned(),
        "Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE/REVIEW blocks.".to_owned(),
        language_rule(params.output_language, params.source_content),
        "## IMPORTANT: Source File".to_owned(),
        format!("The original source file is: **{}**", params.source_identity),
        "All wiki pages generated from this source MUST include this filename in their frontmatter `sources` field.".to_owned(),
        format!("Today's date is **{}**. Use this exact date for all new `created`, `updated`, and wiki/log.md ingest dates.", params.today),
        optional_section(
            !params.schema.is_empty(),
            join_non_empty(vec![
                "## Project Schema and Routing (AUTHORITATIVE)".to_owned(),
                params.schema.to_owned(),
                "Use this schema as the primary routing rule for page types and directories.".to_owned(),
                "If it defines custom folders or distinctions (for example people, technologies, organizations, methods, or cases), write pages into those schema-defined folders instead of forcing them into wiki/entities/ or wiki/concepts/.".to_owned(),
                "Use wiki/entities/ and wiki/concepts/ only when the schema does not provide a more specific destination.".to_owned(),
                "Every generated page's frontmatter type must match the schema directory used in its FILE path.".to_owned(),
            ]),
        ),
        "## What to generate".to_owned(),
        format!("1. A source summary page at **{summary_path}** (MUST use this exact path)"),
        "2. Entity or schema-defined typed pages for key named things identified in the analysis. Prefer schema-defined directories when present; otherwise use wiki/entities/.".to_owned(),
        "3. Concept or schema-defined typed pages for key ideas, methods, techniques, and abstractions. Prefer schema-defined directories when present; otherwise use wiki/concepts/.".to_owned(),
        "4. A log entry for wiki/log.md (just the new entry to append, format: ## [YYYY-MM-DD] ingest | Title)".to_owned(),
        "Do not generate wiki/index.md or wiki/overview.md. The application maintains aggregate navigation separately so large wikis are never rewritten through model output.".to_owned(),
        "## Frontmatter Rules (CRITICAL — parser is strict)".to_owned(),
        "Every page begins with a YAML frontmatter block. Format rules, in order of importance:".to_owned(),
        "1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).".to_owned(),
        "   Do NOT wrap the file in a ```yaml ... ``` code fence.".to_owned(),
        "   Do NOT prefix it with a `frontmatter:` key or any other line.".to_owned(),
        "2. Each frontmatter line is a `key: value` pair on its own line.".to_owned(),
        "3. The frontmatter ends with another `---` line on its own.".to_owned(),
        "4. The next line after the closing `---` is the start of the page body.".to_owned(),
        "5. Arrays use the standard YAML inline form `[a, b, c]` (no outer brackets around each item).".to_owned(),
        "   Wikilinks belong in the BODY only — never write `related: [[a]], [[b]]` (invalid YAML);".to_owned(),
        "   write `related: [a, b]` with bare slugs.".to_owned(),
        "Required fields and types:".to_owned(),
        format!("  • type     — one of the known types ({known_types}), or a custom type explicitly defined by the project schema"),
        "  • title    — string (quote it if it contains a colon, e.g. `title: \"Foo: Bar\"`)".to_owned(),
        format!("  • created  — {} for new pages (YYYY-MM-DD, no quotes)", params.today),
        format!("  • updated  — {} for new pages (same as created)", params.today),
        "  • tags     — array of bare strings: `tags: [microbiology, ai]`".to_owned(),
        "  • related  — array of bare wiki page slugs: `related: [foo, bar-baz]`. Do NOT include".to_owned(),
        "               `wiki/`, `.md`, or `[[…]]` here — slugs only.".to_owned(),
        format!("  • sources  — array of source filenames; MUST include \"{}\".", params.source_identity),
        "Concrete example of a complete, parseable page (everything between the two `---` lines".to_owned(),
        "is the frontmatter; the heading and prose below are the body):".to_owned(),
        "    ---".to_owned(),
        "    type: entity".to_owned(),
        "    title: Example Entity".to_owned(),
        format!("    created: {}", params.today),
        format!("    updated: {}", params.today),
        "    tags: [example, demo]".to_owned(),
        "    related: [related-slug-1, related-slug-2]".to_owned(),
        format!("    sources: [\"{}\"]", params.source_identity),
        "    ---".to_owned(),
        "    # Example Entity".to_owned(),
        "    Body content goes here. Use [[wikilink]] syntax in the body for cross-references.".to_owned(),
        "Other rules:".to_owned(),
        "- Use [[wikilink]] syntax in the BODY for cross-references between pages".to_owned(),
        "- If you include images, use wiki-root-relative paths such as `media/source-slug/image.png`; never output absolute filesystem paths.".to_owned(),
        "- Preserve subject boundaries: when a source discusses multiple entities/models/products/methods, keep claims, evaluations, limitations, benchmark results, and recommendations attached to the exact subject they describe.".to_owned(),
        "- Do not merge or generalize a claim about one subject into another subject's page solely because they share terms (for example context window size, benchmark name, dataset, architecture, or feature name).".to_owned(),
        "- If a page needs to mention another subject for comparison, write it explicitly as a comparison and cite which source/frontmatter `sources` entry supports that statement.".to_owned(),
        "- Use kebab-case for Latin-script filenames; for Chinese/Japanese/Korean titles keep the CJK characters (do NOT romanize to pinyin/romaji or translate to English)".to_owned(),
        "- Derive filenames from the page title in the mandatory output language, but short proper nouns and technical identifiers take precedence: preserve names such as OpenAI, GPT-5, Transformer, CLIP, ImageNet, PyTorch, CUDA, GitHub, arXiv, React, LanceDB, AnyTXT, MinerU, model names, dataset names, tool names, and code identifiers in their standard original form. Do not put raw URLs, citation strings, or full paper titles directly into file paths; convert surrounding descriptive prose to a safe readable title. For Chinese/Japanese/Korean prose titles, keep readable CJK characters in the filename instead of translating the slug to English.".to_owned(),
        "- Preserve structured source data verbatim: copy SQL DDL / CREATE TABLE statements, schema definitions, API signatures, configuration, and tabular data into fenced code blocks (or Markdown tables) in the source summary page instead of paraphrasing them. Exact column names, types, constraints, primary/foreign keys, and indexes must survive ingest — a prose-only summary that drops them loses the structure the user imported the source to keep.".to_owned(),
        "- Follow the analysis recommendations on what to emphasize".to_owned(),
        "- If the analysis found connections to existing pages, add cross-references".to_owned(),
        "## Review block types".to_owned(),
        "After all FILE blocks, optionally emit REVIEW blocks for anything that needs human judgment:".to_owned(),
        "- contradiction: the analysis found conflicts with existing wiki content".to_owned(),
        "- duplicate: an entity/concept might already exist under a different name in the index".to_owned(),
        "- missing-page: an important concept is referenced but has no dedicated page".to_owned(),
        "- suggestion: ideas for further research, related sources to look for, or connections worth exploring".to_owned(),
        "Only create reviews for things that genuinely need human input. Don't create trivial reviews.".to_owned(),
        "## OPTIONS allowed values (only these predefined labels):".to_owned(),
        "- contradiction: OPTIONS: Create Page | Skip".to_owned(),
        "- duplicate: OPTIONS: Create Page | Skip".to_owned(),
        "- missing-page: OPTIONS: Create Page | Skip".to_owned(),
        "- suggestion: OPTIONS: Create Page | Skip".to_owned(),
        "The user also has a 'Deep Research' button (auto-added by the system) that triggers web search.".to_owned(),
        "Do NOT invent custom option labels. Only use 'Create Page' and 'Skip'.".to_owned(),
        "For suggestion and missing-page reviews, the SEARCH field must contain 2-3 web search queries".to_owned(),
        "(keyword-rich, specific, suitable for a search engine — NOT titles or sentences). Example:".to_owned(),
        "  SEARCH: automated technical debt detection AI generated code | software quality metrics LLM code generation | static analysis tools agentic software development".to_owned(),
        optional_section(!params.purpose.is_empty(), format!("## Wiki Purpose\n{}", params.purpose)),
        optional_section(!params.index.is_empty(), format!("## Current Wiki Index (preserve all existing entries, add new ones)\n{}", params.index)),
        optional_section(!params.overview.is_empty(), format!("## Current Overview (update this to reflect the new source)\n{}", params.overview)),
        "## Output Format (MUST FOLLOW EXACTLY — this is how the parser reads your response)".to_owned(),
        "Your ENTIRE response consists of FILE blocks followed by optional REVIEW blocks. Nothing else.".to_owned(),
        "FILE block template:".to_owned(),
        "```".to_owned(),
        "---FILE: wiki/path/to/page.md---".to_owned(),
        "(complete file content with YAML frontmatter)".to_owned(),
        "---END FILE---".to_owned(),
        "```".to_owned(),
        "REVIEW block template (optional, after all FILE blocks):".to_owned(),
        "```".to_owned(),
        "---REVIEW: type | Title---".to_owned(),
        "Description of what needs the user's attention.".to_owned(),
        "OPTIONS: Create Page | Skip".to_owned(),
        "PAGES: wiki/page1.md, wiki/page2.md".to_owned(),
        "SEARCH: query 1 | query 2 | query 3".to_owned(),
        "---END REVIEW---".to_owned(),
        "```".to_owned(),
        "## Output Requirements (STRICT — deviations will cause parse failure)".to_owned(),
        "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).".to_owned(),
        "2. DO NOT output any preamble such as \"Here are the files:\", \"Based on the analysis...\", or any introductory prose.".to_owned(),
        "3. DO NOT echo or restate the analysis — that was stage 1's job. Your job is to emit FILE blocks.".to_owned(),
        "4. DO NOT output markdown tables, bullet lists, or headings outside of FILE/REVIEW blocks.".to_owned(),
        "5. DO NOT output any trailing commentary after the last `---END FILE---` or `---END REVIEW---`.".to_owned(),
        "6. Between blocks, use only blank lines — no prose.".to_owned(),
        "7. FILE block prose (body, explanations, descriptions, section text) must use the mandatory output language specified below. Preserve proper nouns, acronyms, model names, dataset names, tool/library names, code identifiers, URLs, file names, citation strings, paper titles, and technical terms with no widely-used localized equivalent in their standard original form, including in page names and section headings.".to_owned(),
        "If you start with anything other than `---FILE:`, the entire response will be discarded.".to_owned(),
        "---".to_owned(),
        language_rule(params.output_language, params.source_content),
    ])
}

pub fn build_review_suggestion_prompt(params: ReviewSuggestionPromptParams<'_>) -> String {
    let max_ctx = compute_context_budget(params.max_context_size).max_ctx;
    let section_cap = 4_000.max(max_ctx * 15 / 100);
    let index_cap = 3_000.max(section_cap * 8 / 10);
    join_non_empty(vec![
        "You are identifying high-value follow-up research items for a personal wiki.".to_owned(),
        "Your job is NOT to generate wiki pages. The wiki page generation already happened.".to_owned(),
        "Output only REVIEW blocks for unresolved knowledge gaps that deserve human attention or Deep Research.".to_owned(),
        "Prefer 1-5 high-signal reviews. If there is nothing worth reviewing, output nothing.".to_owned(),
        "Return REVIEW blocks only. Do not output FILE blocks. Do not wrap the response in markdown fences.".to_owned(),
        language_rule(params.output_language, params.source_context),
        "Review types:".to_owned(),
        "- contradiction: a conflict or tension that requires user judgment".to_owned(),
        "- duplicate: likely duplicate pages/names that need user review".to_owned(),
        "- missing-page: an important concept is referenced but has no dedicated page".to_owned(),
        "- suggestion: follow-up research, related sources to look for, or connections worth exploring".to_owned(),
        "Use only these options: OPTIONS: Create Page | Skip".to_owned(),
        "For suggestion and missing-page reviews, include a SEARCH line with 2-3 keyword-rich web search queries separated by ` | `.".to_owned(),
        "The user has a Deep Research button added by the system. Do not invent a Deep Research option label.".to_owned(),
        "REVIEW block template:".to_owned(),
        "```".to_owned(),
        "---REVIEW: suggestion | Precise title---".to_owned(),
        "Concise description of the gap and why it matters.".to_owned(),
        "OPTIONS: Create Page | Skip".to_owned(),
        "PAGES: wiki/page1.md, wiki/page2.md".to_owned(),
        "SEARCH: query 1 | query 2 | query 3".to_owned(),
        "---END REVIEW---".to_owned(),
        "```".to_owned(),
        optional_section(!params.purpose.is_empty(), format!("## Wiki Purpose\n{}", trim_long_text(params.purpose, section_cap))),
        optional_section(!params.schema.is_empty(), format!("## Wiki Schema\n{}", trim_long_text(params.schema, section_cap))),
        optional_section(!params.index.is_empty(), format!("## Current Wiki Index\n{}", trim_long_text(params.index, index_cap))),
        optional_section(!params.overview.is_empty(), format!("## Current Overview\n{}", trim_long_text(params.overview, section_cap))),
        format!("## Source identity\n{}", params.source_identity),
        format!("## Stage 1 analysis\n{}", trim_long_text(params.analysis, section_cap)),
        format!("## Source context\n{}", trim_long_text(params.source_context, section_cap)),
        format!("## Generated FILE/REVIEW output to inspect\n{}", trim_long_text(params.generation, section_cap)),
    ])
}

pub fn build_truncated_file_repair_prompt(params: TruncatedFileRepairPromptParams<'_>) -> String {
    let max_ctx = compute_context_budget(params.context.max_context_size).max_ctx;
    let section_cap = 4_000.max(max_ctx * 12 / 100);
    let mut lines = vec![
        "You are repairing truncated wiki FILE blocks from an earlier generation.".to_owned(),
        "Return exactly one complete FILE block for each requested path and no other files.".to_owned(),
        "Every block must end with `---END FILE---`. Do not output a preamble, REVIEW blocks, or trailing commentary.".to_owned(),
        "Preserve the requested paths exactly and include the source identity in each page's frontmatter `sources` field.".to_owned(),
        language_rule(params.output_language, params.context.source_context),
        "## Requested paths".to_owned(),
    ];
    lines.extend(params.paths.iter().map(|path| format!("- {path}")));
    lines.extend([
        format!("## Source identity\n{}", params.source_identity),
        optional_section(
            !params.context.schema.is_empty(),
            format!(
                "## Project schema\n{}",
                trim_long_text(params.context.schema, section_cap)
            ),
        ),
        optional_section(
            !params.context.purpose.is_empty(),
            format!(
                "## Wiki purpose\n{}",
                trim_long_text(params.context.purpose, section_cap)
            ),
        ),
        format!(
            "## Stage 1 analysis\n{}",
            trim_long_text(params.context.analysis, section_cap)
        ),
        format!(
            "## Source context\n{}",
            trim_long_text(params.context.source_context, section_cap)
        ),
    ]);
    join_non_empty(lines)
}

pub fn build_chunk_analysis_system_prompt(params: ChunkAnalysisSystemPromptParams<'_>) -> String {
    join_non_empty(vec![
        "You are analyzing a long source document for a personal wiki.".to_owned(),
        "Do not output chain-of-thought, hidden reasoning, or a thinking transcript.".to_owned(),
        "Analyze only the current MAIN CHUNK. Use overlap and digest for context only.".to_owned(),
        "Keep stable names consistent with the existing wiki and prior digest.".to_owned(),
        language_rule(params.output_language, params.source_content),
        "Output exactly two markdown sections:".to_owned(),
        "## Chunk Analysis".to_owned(),
        "- Concise summary of the main chunk".to_owned(),
        "- New or updated entities".to_owned(),
        "- New or updated concepts".to_owned(),
        "- Any schema-defined page types beyond entity/concept that the main chunk genuinely supports".to_owned(),
        "- Claims, findings, evidence, contradictions".to_owned(),
        "- Exact structured data from this chunk, when present: preserve SQL DDL / CREATE TABLE statements, schema definitions, API signatures, configuration, and tables verbatim in fenced code blocks or Markdown tables; retain field names, types, constraints, keys, and indexes".to_owned(),
        "- Open questions or research gaps".to_owned(),
        "## Updated Global Digest".to_owned(),
        "A compact document-level digest that incorporates this chunk and preserves prior cross-chunk context.".to_owned(),
        "Keep this digest structured under: Summary, Entities, Concepts, Schema-Typed Candidates, Claims, Evidence, Contradictions, Open Questions, Cross-Chunk Relations.".to_owned(),
        "Use schema-defined types only when the source actually supports them; never invent goals, habits, journal entries, decisions, or similar user-authored records that are not present in the source.".to_owned(),
        "Stable project context follows. It changes rarely and should be treated as background:".to_owned(),
        optional_section(!params.purpose.is_empty(), format!("## Wiki Purpose\n{}", params.purpose)),
        optional_section(!params.schema.is_empty(), format!("## Wiki Schema\n{}", params.schema)),
        optional_section(!params.index.is_empty(), format!("## Current Wiki Index\n{}", trim_long_text(params.index, 40_000))),
    ])
}

pub fn build_chunk_analysis_user_prompt(params: ChunkAnalysisUserPromptParams<'_>) -> String {
    join_non_empty(vec![
        format!("Source file: {}", params.source_identity),
        optional_section(params.folder_context.is_some(), format!("Folder context: {}", params.folder_context.unwrap_or_default())),
        format!("Chunk: {}/{}", params.chunk.index, params.chunk.total),
        optional_section(!params.chunk.heading_path.is_empty(), format!("Heading path: {}", params.chunk.heading_path)),
        "## Current Global Digest".to_owned(),
        if params.global_digest.is_empty() { "(No prior digest yet.)".to_owned() } else { params.global_digest.to_owned() },
        optional_section(!params.chunk.overlap_before.is_empty(), format!("## Previous Overlap Context\n{}", params.chunk.overlap_before)),
        "## MAIN CHUNK TO ANALYZE".to_owned(),
        params.chunk.main.to_owned(),
        "Return only the two requested sections. Do not repeat overlap-only facts unless the main chunk supports them.".to_owned(),
    ])
}

pub fn build_page_merge_system_prompt() -> String {
    [
        "You are merging two versions of the same wiki page into one coherent document.",
        "Both versions target the same wiki page; one is already on disk,",
        "the other was just generated from a different source document.",
        "Either version may mention additional subjects for comparison or context.",
        "",
        "Output ONE merged version that:",
        "- Preserves every factual claim from both versions (do not drop content)",
        "- Eliminates redundancy when both versions state the same fact",
        "- Preserves subject/source boundaries: if either version mentions other entities/models/products/methods for comparison, keep those comparisons attribution-exact and do not fold them into claims about the main page subject",
        "- When claims conflict or apply to different subjects, keep them separated and say which source version supports each one instead of synthesizing a single generalized conclusion",
        "- When in doubt whether two similar-looking claims describe the same fact, prefer keeping them separate",
        "- Reorganizes sections so the structure is logical for the merged topic,",
        "  not just a concatenation of the two inputs",
        "- Uses consistent markdown structure (headings, tables, lists, callouts)",
        "- Keeps `[[wikilink]]` references intact",
        "",
        "Output requirements:",
        "- The FIRST character of your response MUST be `-` (the opening of `---`)",
        "- Output the COMPLETE file: YAML frontmatter + body",
        "- No preamble (no \"Here is the merged version:\"), no analysis prose",
        "- The caller will overwrite `sources`/`tags`/`related`/`updated` with",
        "  deterministic values — your job is the body and any other fields",
    ]
    .join("\n")
}

pub fn trim_long_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    format!(
        "{}\n\n[...trimmed for prompt budget...]",
        text.chars().take(max_chars).collect::<String>().trim_end()
    )
}

fn clamp_usize(value: isize, min: usize, max: usize) -> usize {
    (value.max(min as isize).min(max as isize)) as usize
}

fn join_non_empty(lines: Vec<String>) -> String {
    lines
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn optional_section(include: bool, content: String) -> String {
    if include { content } else { String::new() }
}

fn strip_extension(path: &str) -> &str {
    path.rsplit_once('.')
        .filter(|(_, extension)| !extension.is_empty())
        .map(|(stem, _)| stem)
        .unwrap_or(path)
}

fn language_prompt_name(language: &str) -> String {
    match language {
        "Arabic" => "Arabic / العربية".to_owned(),
        "Persian" => "Persian (Farsi / فارسی)".to_owned(),
        "Hebrew" => "Hebrew / עברית".to_owned(),
        "Chinese" => "Chinese".to_owned(),
        "Traditional Chinese" => "Traditional Chinese".to_owned(),
        "Japanese" => "Japanese".to_owned(),
        "Korean" => "Korean".to_owned(),
        "Czech" => "Czech / čeština".to_owned(),
        "" => "English".to_owned(),
        other => other.to_owned(),
    }
}

fn detect_language(text: &str) -> String {
    let mut chinese = 0;
    let mut japanese = 0;
    let mut korean = 0;
    let mut arabic = 0;
    let mut persian = 0;
    let mut hebrew = 0;
    let mut thai = 0;
    let mut hindi = 0;
    let mut cyrillic = 0;
    let mut greek = 0;

    for ch in text.chars() {
        let cp = ch as u32;
        match cp {
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0xF900..=0xFAFF => chinese += 1,
            0x3040..=0x309F | 0x30A0..=0x30FF | 0x31F0..=0x31FF | 0xFF65..=0xFF9F => japanese += 1,
            0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F => korean += 1,
            0x0600..=0x06FF
            | 0x0750..=0x077F
            | 0x08A0..=0x08FF
            | 0xFB50..=0xFDFF
            | 0xFE70..=0xFEFF => {
                arabic += 1;
                if matches!(ch, 'پ' | 'چ' | 'ژ' | 'گ' | 'ک' | 'ی') {
                    persian += 1;
                }
            }
            0x0590..=0x05FF | 0xFB1D..=0xFB4F => hebrew += 1,
            0x0E00..=0x0E7F => thai += 1,
            0x0900..=0x097F => hindi += 1,
            0x0400..=0x04FF | 0x0500..=0x052F => cyrillic += 1,
            0x0370..=0x03FF | 0x1F00..=0x1FFF => greek += 1,
            _ => {}
        }
    }

    if japanese > 0 && chinese > 0 {
        return "Japanese".to_owned();
    }

    let scripts = [
        ("Chinese", chinese),
        ("Japanese", japanese),
        ("Korean", korean),
        (
            if persian >= 3 && persian > arabic - persian {
                "Persian"
            } else {
                "Arabic"
            },
            arabic,
        ),
        ("Hebrew", hebrew),
        ("Thai", thai),
        ("Hindi", hindi),
        ("Russian", cyrillic),
        ("Greek", greek),
    ];
    scripts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .filter(|(_, count)| *count >= 2)
        .map(|(language, _)| language.to_owned())
        .unwrap_or_else(|| detect_latin_language(text).unwrap_or_else(|| "English".to_owned()))
}

fn detect_latin_language(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let words = lower
        .split(|ch: char| !ch.is_alphabetic())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    if lower
        .chars()
        .any(|ch| "ảạắằẳẵặấầẩẫậđẻẽẹếềểễệỉĩịỏọốồổỗộơớờởỡợủũụưứừửữựỷỹỵ".contains(ch))
    {
        return Some("Vietnamese".to_owned());
    }
    if lower.chars().any(|ch| "ąćęłńśźż".contains(ch)) {
        return Some("Polish".to_owned());
    }
    if lower.chars().any(|ch| "ěšžřďťňů".contains(ch)) {
        return Some("Czech".to_owned());
    }
    if lower.chars().any(|ch| "ğışş".contains(ch)) {
        return Some("Turkish".to_owned());
    }
    if lower.chars().any(|ch| "ățș".contains(ch)) {
        return Some("Romanian".to_owned());
    }
    if lower.chars().any(|ch| "őű".contains(ch)) {
        return Some("Hungarian".to_owned());
    }
    if lower.chars().any(|ch| "ß".contains(ch))
        || has_any_word(&words, &["der", "die", "das", "und", "nicht", "ist", "mit"])
    {
        return Some("German".to_owned());
    }
    if lower.chars().any(|ch| "çêëîïôûù".contains(ch))
        || has_any_word(&words, &["le", "la", "les", "des", "une", "avec", "pour"])
    {
        return Some("French".to_owned());
    }
    if lower.chars().any(|ch| "ãõ".contains(ch))
        || has_any_word(&words, &["que", "para", "com", "uma", "não"])
    {
        return Some("Portuguese".to_owned());
    }
    if lower.chars().any(|ch| "ñ¿¡".contains(ch))
        || has_any_word(&words, &["el", "los", "las", "una", "con", "para", "que"])
    {
        return Some("Spanish".to_owned());
    }
    if has_any_word(&words, &["il", "lo", "gli", "della", "che", "con", "per"]) {
        return Some("Italian".to_owned());
    }
    if has_any_word(&words, &["het", "een", "van", "voor", "niet"]) {
        return Some("Dutch".to_owned());
    }
    if lower.chars().any(|ch| "åäö".contains(ch)) {
        return Some("Swedish".to_owned());
    }
    if lower.chars().any(|ch| "øæ".contains(ch)) {
        return Some("Norwegian".to_owned());
    }
    if has_any_word(&words, &["og", "ikke", "for", "med"]) {
        return Some("Danish".to_owned());
    }
    if has_any_word(&words, &["ja", "että", "ovat", "kanssa"]) {
        return Some("Finnish".to_owned());
    }
    if has_any_word(&words, &["yang", "dan", "untuk", "dengan"]) {
        return Some("Indonesian".to_owned());
    }
    if has_any_word(&words, &["na", "kwa", "ya", "katika"]) {
        return Some("Swahili".to_owned());
    }
    None
}

fn has_any_word(words: &[&str], needles: &[&str]) -> bool {
    needles
        .iter()
        .filter(|needle| words.iter().any(|word| *word == **needle))
        .count()
        >= 2
}
