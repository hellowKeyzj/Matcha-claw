use std::{collections::BTreeSet, path::Path};

use futures_util::{StreamExt, stream};
use tokio_util::sync::CancellationToken;

use super::ResearchSource;
use crate::{
    WikiFailure,
    external_search::ExternalSearch,
    ports::{
        WikiIngestLlm, WikiIngestLlmMessage, WikiIngestLlmOptions, WikiIngestLlmRequest,
        WikiIngestLlmRole,
    },
    search_config::{DeepResearchSource, SearchConfig, SearchCredentials},
};

pub(crate) async fn collect(
    search: &ExternalSearch,
    queries: &[String],
    config: &SearchConfig,
    credentials: &SearchCredentials,
    llm: Option<&dyn WikiIngestLlm>,
    model_ref: Option<&str>,
    root: &Path,
    cancellation: &CancellationToken,
) -> Result<(Vec<ResearchSource>, Vec<String>), WikiFailure> {
    let web = async {
        if !matches!(
            config.deep_research_source,
            DeepResearchSource::Web | DeepResearchSource::Both
        ) || !crate::search_config::has_configured_web(config)
        {
            return Vec::new();
        }
        stream::iter(0..queries.len())
            .map(|index| async move {
                search
                    .web_search(&queries[index], config, credentials, 5, cancellation)
                    .await
            })
            .buffered(4)
            .collect::<Vec<_>>()
            .await
    };
    let local = async {
        if !matches!(
            config.deep_research_source,
            DeepResearchSource::Anytxt | DeepResearchSource::Both
        ) || !config.any_txt.enabled
            || config.any_txt.endpoint.trim().is_empty()
        {
            return Ok((Vec::new(), Vec::new()));
        }
        let mut prepared = unique(queries.iter().cloned());
        if let Some(llm) = llm {
            let prompt = format!(
                "Convert the user's search or research topics into concise AnyTXT local file search keyword queries.\n\nAnyTXT searches local indexed file text. Natural-language questions often fail, so produce keyword-style searches.\nRules:\n- Return ONLY a JSON array of strings.\n- Produce 1-3 search queries total.\n- Keep proper nouns, filenames, technical terms, dates, abbreviations, and non-English terms.\n- Prefer compact keyword phrases over full questions.\n- Do not add explanations, markdown, comments, or code fences.\n\nUser topics:\n{}",
                serde_json::to_string(queries).expect("queries encode")
            );
            let request = WikiIngestLlmRequest {
                model_ref: model_ref.map(str::to_owned),
                messages: vec![WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::User,
                    content: prompt,
                }],
                options: WikiIngestLlmOptions {
                    temperature: Some(0.1),
                    max_output_tokens: Some(512),
                },
            };
            match llm
                .generate_cancellable(request, cancellation.clone())
                .await
            {
                Ok(response) => {
                    let text = super::synthesis::clean(&response.text)
                        .replace("```json", "")
                        .replace("```", "");
                    let rewritten = text
                        .find('[')
                        .zip(text.rfind(']'))
                        .filter(|(start, end)| start < end)
                        .and_then(|(start, end)| {
                            serde_json::from_str::<Vec<String>>(&text[start..=end]).ok()
                        })
                        .unwrap_or_else(|| {
                            text.lines()
                                .map(|line| line.trim_start_matches(['-', '*', ' ']).to_owned())
                                .collect()
                        });
                    prepared = unique(rewritten.into_iter().chain(prepared));
                }
                Err(error) if error.is_cancelled() => return Err(error),
                Err(_) => {}
            }
        }
        let mut anytxt = config.any_txt.clone();
        if anytxt.filter_dir.trim().is_empty() && root.to_string_lossy().starts_with('/') {
            anytxt.filter_dir = "/".to_owned();
        }
        let prepared = prepared.as_slice();
        let anytxt = &anytxt;
        let settled = stream::iter(0..prepared.len())
            .map(|index| async move {
                search
                    .anytxt_search(&prepared[index], anytxt, 15, cancellation)
                    .await
            })
            .buffered(3)
            .collect::<Vec<_>>()
            .await;
        combine(
            settled,
            15,
            "AnyTXT research source search failed. Check the local search service.",
        )
    };
    if cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    let (web, local) = tokio::join!(web, local);
    let (mut results, mut errors) = combine(
        web,
        20,
        "Web research source search failed. Check the search provider configuration.",
    )?;
    let (local, local_errors) = local?;
    let mut seen = results.iter().map(source_key).collect();
    add(&mut results, &mut seen, local, 20);
    errors.extend(local_errors);
    Ok((results, errors))
}

fn combine(
    settled: Vec<Result<Vec<ResearchSource>, WikiFailure>>,
    cap: usize,
    message: &str,
) -> Result<(Vec<ResearchSource>, Vec<String>), WikiFailure> {
    let mut results = Vec::new();
    let mut seen = BTreeSet::new();
    let mut errors = Vec::new();
    for result in settled {
        match result {
            Ok(found) => add(&mut results, &mut seen, found, cap),
            Err(error) if error.is_cancelled() => return Err(error),
            Err(_) => errors.push(message.to_owned()),
        }
    }
    Ok((results, errors))
}

fn unique(queries: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    queries
        .map(|query| query.trim().trim_matches(['\'', '"']).to_owned())
        .filter(|query| !query.is_empty() && seen.insert(query.to_lowercase()))
        .take(3)
        .collect()
}

fn source_key(source: &ResearchSource) -> String {
    if source.url.is_empty() {
        format!("{}:{}:{}", source.source, source.title, source.snippet)
    } else {
        source.url.clone()
    }
    .to_lowercase()
}

fn add(
    results: &mut Vec<ResearchSource>,
    seen: &mut BTreeSet<String>,
    found: Vec<ResearchSource>,
    cap: usize,
) {
    for source in found {
        if results.len() == cap {
            break;
        }
        if seen.insert(source_key(&source)) {
            results.push(source);
        }
    }
}
