use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use serde_json::Value;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::{Page, call_llm, check_cancelled, group_key, prompts};
use crate::{
    domain::{WikiChunk, WikiDuplicateGroup, WikiFailure, WikiRevision},
    index::WikiVectorIndex,
    ingest::write::{parse_frontmatter_array, parse_frontmatter_scalar},
    ports::WikiIngestLlm,
    search_config::{EmbeddingConfig, EmbeddingCredentials},
};

struct Summary {
    slug: String,
    path: String,
    kind: String,
    title: String,
    description: String,
    tags: Vec<String>,
}

fn summary(page: &Page) -> Option<Summary> {
    if !page.path.starts_with("wiki/entities/") && !page.path.starts_with("wiki/concepts/") {
        return None;
    }
    let content = page.content.replace("\r\n", "\n");
    let after_open = content.strip_prefix("---\n")?;
    let (yaml, body) = after_open.split_once("\n---")?;
    let fields: serde_yaml::Value = serde_yaml::from_str(yaml).ok()?;
    if !fields.is_mapping() {
        return None;
    }
    let slug = std::path::Path::new(&page.path)
        .file_stem()?
        .to_str()?
        .to_owned();
    let scalar =
        |field| parse_frontmatter_scalar(&content, field).filter(|value| !value.trim().is_empty());
    let description = scalar("description").unwrap_or_else(|| {
        body.lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with(['#', '|']))
            .unwrap_or("")
            .to_owned()
    });
    let description = if description.chars().count() > 200 {
        format!("{}…", description.chars().take(199).collect::<String>())
    } else {
        description
    };
    Some(Summary {
        slug: slug.clone(),
        path: page.path.clone(),
        kind: scalar("type").unwrap_or_else(|| "unknown".to_owned()),
        title: scalar("title").unwrap_or(slug),
        description,
        tags: parse_frontmatter_array(&content, "tags"),
    })
}

pub(crate) async fn detect(
    pages: &[Page],
    exclusions: &[Vec<String>],
    llm: &Arc<dyn WikiIngestLlm>,
    model_ref: Option<String>,
    vector: &Arc<dyn WikiVectorIndex>,
    embedding: &EmbeddingConfig,
    credentials: &EmbeddingCredentials,
    cancellation: &CancellationToken,
) -> Result<Vec<WikiDuplicateGroup>, WikiFailure> {
    let summaries = pages.iter().filter_map(summary).collect::<Vec<_>>();
    if summaries.len() < 2 {
        return Ok(Vec::new());
    }
    let excluded = exclusions
        .iter()
        .map(|slugs| group_key(slugs))
        .collect::<BTreeSet<_>>();
    let batches = if embedding.is_ready() {
        match candidate_batches(
            &summaries,
            &excluded,
            vector,
            embedding,
            credentials,
            cancellation,
        )
        .await
        {
            Ok(batches) => batches,
            Err(failure) if failure.is_cancelled() => return Err(failure),
            Err(_) => {
                eprintln!("[wiki:dedup] embedding prefilter failed; using bounded detector scan");
                bounded_batches(&summaries)
            }
        }
    } else {
        bounded_batches(&summaries)
    };
    let mut groups = Vec::new();
    let mut seen = BTreeSet::new();
    for batch in batches {
        check_cancelled(cancellation)?;
        let entries = batch
            .iter()
            .map(|summary| {
                let tags = if summary.tags.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", summary.tags.join(", "))
                };
                let description = if summary.description.is_empty() {
                    String::new()
                } else {
                    format!(" — {}", summary.description)
                };
                format!(
                    "- type={}, slug={}, title={}{}{}",
                    summary.kind,
                    summary.slug,
                    serde_json::to_string(&summary.title).expect("string serialization"),
                    tags,
                    description
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let user = format!(
            "## Wiki pages to scan ({} entries)\n\n{entries}\n\nReturn duplicate groups as JSON only.",
            batch.len()
        );
        let response = call_llm(
            llm,
            model_ref.clone(),
            prompts::DETECTOR,
            user,
            8192,
            cancellation,
        )
        .await?;
        let valid = batch
            .iter()
            .map(|summary| summary.slug.as_str())
            .collect::<BTreeSet<_>>();
        for mut group in parse_groups(&response) {
            let mut unique = BTreeSet::new();
            group
                .slugs
                .retain(|slug| valid.contains(slug.as_str()) && unique.insert(slug.to_lowercase()));
            let key = group_key(&group.slugs);
            if group.slugs.len() >= 2 && !excluded.contains(&key) && seen.insert(key) {
                groups.push(group);
            }
        }
    }
    Ok(groups)
}

fn bounded_batches(summaries: &[Summary]) -> Vec<Vec<&Summary>> {
    let mut ordered = summaries.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        left.title
            .cmp(&right.title)
            .then(left.slug.cmp(&right.slug))
    });
    split_batches(&ordered)
}

fn split_batches<'a>(summaries: &[&'a Summary]) -> Vec<Vec<&'a Summary>> {
    if summaries.len() <= 80 {
        return if summaries.len() < 2 {
            Vec::new()
        } else {
            vec![summaries.to_vec()]
        };
    }
    (0..summaries.len())
        .step_by(72)
        .map(|start| summaries[start..(start + 80).min(summaries.len())].to_vec())
        .filter(|batch| batch.len() >= 2)
        .collect()
}

async fn candidate_batches<'a>(
    summaries: &'a [Summary],
    excluded: &BTreeSet<String>,
    vector: &Arc<dyn WikiVectorIndex>,
    config: &EmbeddingConfig,
    credentials: &EmbeddingCredentials,
    cancellation: &CancellationToken,
) -> Result<Vec<Vec<&'a Summary>>, WikiFailure> {
    let subset = &summaries[..summaries.len().min(5000)];
    let mut embeddings = Vec::with_capacity(subset.len());
    let slots = Semaphore::new(1);
    for summary in subset {
        check_cancelled(cancellation)?;
        let text = [
            summary.slug.clone(),
            summary.title.clone(),
            summary.tags.join(" "),
            summary.description.chars().take(1500).collect(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
        // prepare_page performs real embedding without writing the index or taking its revision fast path.
        let chunk = [WikiChunk::new(
            summary.path.clone(),
            0,
            text.clone(),
            String::new(),
        )];
        let revision = WikiRevision::for_bytes(text.as_bytes(), 0);
        let prepared = tokio::select! {
            _ = cancellation.cancelled() => return Err(WikiFailure::cancelled()),
            prepared = vector.prepare_page(&summary.path, "", &revision, &chunk, config, credentials, &slots) => prepared,
        };
        embeddings.push(
            prepared
                .ok()
                .and_then(|prepared| prepared.rows.into_iter().next())
                .map(|row| row.embedding)
                .filter(|embedding| !embedding.is_empty()),
        );
    }
    let embedded = embeddings
        .iter()
        .filter(|embedding| embedding.is_some())
        .count();
    if embedded < 2 || embedded * 5 < subset.len() * 4 {
        eprintln!(
            "[wiki:dedup] embedding coverage={embedded}/{}",
            subset.len()
        );
        return if summaries.len() > 250 {
            Ok(Vec::new())
        } else {
            Ok(bounded_batches(summaries))
        };
    }
    let mut pairs = BTreeSet::new();
    for (index, embedding) in embeddings.iter().enumerate() {
        check_cancelled(cancellation)?;
        let Some(embedding) = embedding else {
            continue;
        };
        let mut scored = embeddings
            .iter()
            .enumerate()
            .filter_map(|(other, candidate)| {
                if index == other {
                    return None;
                }
                let score = cosine(embedding, candidate.as_deref()?);
                (score >= 0.68).then_some((other, score))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| right.1.total_cmp(&left.1));
        for (other, _) in scored.into_iter().take(8) {
            pairs.insert((index.min(other), index.max(other)));
        }
    }
    if pairs.is_empty() {
        return if summaries.len() <= 250 {
            Ok(bounded_batches(summaries))
        } else {
            Ok(Vec::new())
        };
    }
    let mut parent = (0..subset.len()).collect::<Vec<_>>();
    for (left, right) in pairs {
        if excluded.contains(&group_key(&[
            subset[left].slug.clone(),
            subset[right].slug.clone(),
        ])) {
            continue;
        }
        let left = root(&mut parent, left);
        let right = root(&mut parent, right);
        parent[left] = right;
    }
    let mut clusters = BTreeMap::<usize, Vec<&Summary>>::new();
    for (index, summary) in subset.iter().enumerate() {
        clusters
            .entry(root(&mut parent, index))
            .or_default()
            .push(summary);
    }
    let mut batches = Vec::new();
    let mut current = Vec::new();
    for cluster in clusters.into_values().filter(|cluster| cluster.len() >= 2) {
        if current.len() + cluster.len() > 80 && !current.is_empty() {
            batches.push(std::mem::take(&mut current));
        }
        current.extend(cluster);
        if current.len() >= 80 {
            batches.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        batches.push(current);
    }
    Ok(batches)
}

fn root(parent: &mut [usize], mut index: usize) -> usize {
    while parent[index] != index {
        parent[index] = parent[parent[index]];
        index = parent[index];
    }
    index
}

fn cosine(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() {
        return 0.0;
    }
    let (dot, left_norm, right_norm) = left.iter().zip(right).fold(
        (0.0, 0.0, 0.0),
        |(dot, left_norm, right_norm), (left, right)| {
            (
                dot + left * right,
                left_norm + left * left,
                right_norm + right * right,
            )
        },
    );
    let norm = left_norm.sqrt() * right_norm.sqrt();
    if norm == 0.0 { 0.0 } else { dot / norm }
}

fn parse_groups(raw: &str) -> Vec<WikiDuplicateGroup> {
    let Some(start) = raw.find('{') else {
        return Vec::new();
    };
    let mut parser = serde_json::Deserializer::from_str(&raw[start..]).into_iter::<Value>();
    let Some(Ok(value)) = parser.next() else {
        return Vec::new();
    };
    let Some(groups) = value.get("groups").and_then(Value::as_array) else {
        return Vec::new();
    };
    groups
        .iter()
        .filter_map(|group| {
            let slugs = group
                .get("slugs")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if slugs.len() < 2 {
                return None;
            }
            let confidence = match group.get("confidence").and_then(Value::as_str) {
                Some("high") => "high",
                Some("medium") => "medium",
                _ => "low",
            };
            Some(WikiDuplicateGroup {
                slugs,
                reason: group
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                confidence: confidence.to_owned(),
            })
        })
        .collect()
}
