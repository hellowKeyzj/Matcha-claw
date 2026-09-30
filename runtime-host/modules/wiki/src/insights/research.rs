use std::path::Path;

use super::{WikiGraphInsightResearchReceipt, WikiKnowledgeGap};
use crate::{
    WikiFailure,
    ports::{WikiIngestLlmMessage, WikiIngestLlmOptions, WikiIngestLlmRequest, WikiIngestLlmRole},
};

pub(crate) fn research_request(
    root: &Path,
    gap: &WikiKnowledgeGap,
    model_ref: Option<String>,
    language: &str,
) -> Result<WikiIngestLlmRequest, WikiFailure> {
    fn context(path: &Path) -> Result<String, WikiFailure> {
        match std::fs::read_to_string(path) {
            Ok(content) => Ok(content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(WikiFailure::io(path.to_string_lossy(), error)),
        }
    }
    let overview = context(&root.join("wiki/overview.md"))?;
    let purpose = context(&root.join("purpose.md"))?;
    let directive = crate::ingest::prompts::language_rule(
        Some(language),
        &format!("{} {} {purpose} {overview}", gap.title, gap.description),
    );
    let mut sections = vec![
        "You are a research assistant. Given a knowledge gap found in a personal wiki, generate a precise research topic and search queries.".to_owned(),
        directive,
        "## Wiki Context".to_owned(),
    ];
    if !purpose.is_empty() {
        sections.push(format!("### Purpose\n{purpose}"));
    }
    if !overview.is_empty() {
        sections.push(format!("### Current Overview\n{overview}"));
    }
    sections.extend([
        "## Knowledge Gap".to_owned(),
        format!("Type: {}", gap.r#type.as_str()),
        format!("Title: {}", gap.title),
        format!("Description: {}", gap.description),
        "## Task\nGenerate a research topic and search queries that are specific to this wiki's domain and purpose.\nThe topic should precisely describe what information would fill this knowledge gap.\nThe search queries should be optimized for web search engines — keyword-rich, specific, not generic.".to_owned(),
        "## Output Format (STRICT — follow exactly, no other text)\nRespond with EXACTLY 4 lines, no more:\nTOPIC: <one sentence — MUST be in the mandatory output language declared above>\nQUERY: <query 1 — may use English keywords if they better match search engines>\nQUERY: <query 2>\nQUERY: <query 3>".to_owned(),
    ]);
    Ok(WikiIngestLlmRequest {
        model_ref,
        messages: vec![WikiIngestLlmMessage {
            role: WikiIngestLlmRole::User,
            content: sections.join("\n\n"),
        }],
        options: WikiIngestLlmOptions::default(),
    })
}

pub(crate) fn parse_research_input(
    text: &str,
    project_id: &str,
    gap: &WikiKnowledgeGap,
) -> WikiGraphInsightResearchReceipt {
    let text = crate::research::synthesis::clean(text);
    let mut topic = None;
    let mut search_queries = Vec::new();
    for line in text.lines() {
        if let Some(value) = line
            .strip_prefix("TOPIC:")
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if topic.is_none() {
                topic = Some(value.to_owned());
            }
        }
        if let Some(value) = line
            .strip_prefix("QUERY:")
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if search_queries.len() < 3 {
                search_queries.push(value.to_owned());
            }
        }
    }
    let topic = topic.unwrap_or_else(|| gap.title.clone());
    if search_queries.is_empty() {
        search_queries.push(topic.clone());
    }
    WikiGraphInsightResearchReceipt {
        project_id: project_id.to_owned(),
        insight_key: gap.key.clone(),
        topic,
        search_queries,
    }
}
