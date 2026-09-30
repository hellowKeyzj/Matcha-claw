use std::collections::BTreeSet;

use super::{ResearchSource, WikiResearchTask};
use crate::{
    WikiFailure,
    ports::{WikiIngestLlmMessage, WikiIngestLlmOptions, WikiIngestLlmRequest, WikiIngestLlmRole},
};

pub(crate) fn request(
    task: &WikiResearchTask,
    model_ref: Option<String>,
    language: &str,
    index: &str,
) -> WikiIngestLlmRequest {
    let language = crate::ingest::prompts::language_rule(Some(language), &task.topic);
    let mut system = format!(
        "You are a research assistant. Synthesize the collected research sources into a comprehensive wiki page.\n\n{language}\n\n## Cross-referencing (IMPORTANT)\n- The wiki already has existing pages listed in the Wiki Index below.\n- When your synthesis mentions an entity or concept that exists in the wiki, ALWAYS use [[wikilink]] syntax to link to it.\n- For example, if the wiki has an entity 'anthropic', write [[anthropic]] when mentioning it.\n- This is critical for connecting new research to existing knowledge in the graph.\n\n## Writing Rules\n- Organize into clear sections with headings\n- Cite sources using [N] notation\n- Note contradictions or gaps\n- Suggest additional sources worth finding\n- Neutral, encyclopedic tone"
    );
    if !index.is_empty() {
        system.push_str(&format!(
            "\n\n## Existing Wiki Index (link to these pages with [[wikilink]])\n{index}"
        ));
    }
    let context = task
        .web_results
        .iter()
        .enumerate()
        .map(|(index, source)| {
            format!(
                "[{}] **{}** ({})\n{}",
                index + 1,
                source.title,
                source.source,
                source.snippet
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    WikiIngestLlmRequest {
        model_ref,
        messages: vec![
            WikiIngestLlmMessage {
                role: WikiIngestLlmRole::System,
                content: system,
            },
            WikiIngestLlmMessage {
                role: WikiIngestLlmRole::User,
                content: format!(
                    "Research topic: **{}**\n\n## Research Sources\n\n{context}\n\nSynthesize into a wiki page.",
                    task.topic
                ),
            },
        ],
        options: WikiIngestLlmOptions::default(),
    }
}

pub(crate) fn clean(content: &str) -> String {
    let mut output = String::new();
    let mut rest = content;
    loop {
        let lower = rest.to_ascii_lowercase();
        let opening = ["<think>", "<thinking>"]
            .iter()
            .filter_map(|tag| lower.find(tag).map(|index| (index, *tag)))
            .min_by_key(|(index, _)| *index);
        let Some((start, tag)) = opening else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..start]);
        let closing = if tag == "<think>" {
            "</think>"
        } else {
            "</thinking>"
        };
        let Some(end) = lower[start + tag.len()..].find(closing) else {
            break;
        };
        rest = &rest[start + tag.len() + end + closing.len()..];
    }
    output.trim().to_owned()
}

pub(crate) fn validate(
    content: &str,
    source_count: usize,
) -> Result<(String, Vec<usize>), WikiFailure> {
    let cleaned = clean(content);
    let meaningful = |text: &str| {
        text.chars()
            .filter(|character| character.is_alphanumeric())
            .count()
    };
    let mut block_chars = 0;
    let mut valid_block = false;
    for line in cleaned.lines() {
        if line.trim().is_empty() {
            block_chars = 0;
            continue;
        }
        let trimmed = line.trim_start();
        let heading_chars = trimmed
            .bytes()
            .take_while(|character| *character == b'#')
            .count();
        let prose = if line.len() - trimmed.len() <= 3
            && (1..=6).contains(&heading_chars)
            && trimmed[heading_chars..].starts_with(char::is_whitespace)
        {
            trimmed[heading_chars..].trim_start()
        } else {
            line
        };
        block_chars += meaningful(prose);
        valid_block |= block_chars >= 40;
    }
    if meaningful(&cleaned) < 120 || !valid_block {
        return Err(WikiFailure::state(
            "The research synthesis was empty or incomplete. Please rerun.",
        ));
    }
    let mut cited = BTreeSet::new();
    for marker in cleaned
        .split('[')
        .skip(1)
        .filter_map(|part| part.split_once(']').map(|(marker, _)| marker))
    {
        for part in marker.split(',') {
            if let Some((start, end)) = part.trim().split_once('-') {
                if let (Ok(start), Ok(end)) =
                    (start.trim().parse::<usize>(), end.trim().parse::<usize>())
                {
                    if start <= end && end - start <= source_count {
                        cited.extend(
                            (start..=end).filter(|index| *index > 0 && *index <= source_count),
                        );
                    }
                }
            } else if let Ok(index) = part.trim().parse::<usize>() {
                if index > 0 && index <= source_count {
                    cited.insert(index);
                }
            }
        }
    }
    if cited.is_empty() {
        return Err(WikiFailure::state(
            "The research synthesis did not cite any collected sources. Please rerun.",
        ));
    }
    Ok((cleaned, cited.into_iter().collect()))
}

pub(crate) fn page(
    topic: &str,
    date: &str,
    synthesis: &str,
    sources: &[ResearchSource],
    cited: &[usize],
) -> String {
    let title = format!(
        "Research: {}",
        topic.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    let references = cited
        .iter()
        .map(|index| {
            let source = &sources[index - 1];
            format!(
                "{index}. [{}]({}) — {}",
                source.title, source.url, source.source
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    crate::owner::source_lifecycle::strip_body_wikilink_path_prefixes(&format!(
        "---\ntype: query\ntitle: {}\ncreated: {date}\norigin: deep-research\ntags: [research]\n---\n\n# {title}\n\n{synthesis}\n\n## References\n\n{references}\n",
        serde_json::to_string(&title).expect("string encodes")
    ))
}
