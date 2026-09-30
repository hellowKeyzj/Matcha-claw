use std::{collections::HashMap, future::Future, path::Path, pin::Pin, time::Duration};

use futures_util::{StreamExt, TryStreamExt, stream};
use serde::{Deserialize, Serialize};

use crate::{
    domain::{
        SearchPage, WikiChunk, WikiFailure, WikiRetrieveContextInput, WikiRevision, WikiSearchHit,
        WikiSearchReceipt, extract_search_images, finish_search, keyword_hits, load_search_pages,
        stable_content_hash,
    },
    embedding::{Embedder, supports_batch},
    search_config::{EmbeddingConfig, EmbeddingCredentials},
    vector::{self, ChunkEmbedding, PageSearchResult},
};

type WikiIndexFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub struct PreparedPageEmbedding {
    pub(crate) page_id: String,
    pub(crate) fingerprint: String,
    pub(crate) rows: Vec<ChunkEmbedding>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WikiIndexFailure {
    LanceDbUnavailable { reason: String },
    EmbeddingUnavailable { reason: String },
}

impl WikiIndexFailure {
    pub fn lancedb(reason: impl Into<String>) -> Self {
        Self::LanceDbUnavailable {
            reason: reason.into(),
        }
    }

    pub fn embedding(reason: impl Into<String>) -> Self {
        Self::EmbeddingUnavailable {
            reason: reason.into(),
        }
    }
}

impl From<WikiIndexFailure> for WikiFailure {
    fn from(failure: WikiIndexFailure) -> Self {
        match failure {
            WikiIndexFailure::LanceDbUnavailable { reason } => WikiFailure::IndexUnavailable {
                backend: "lancedb".to_owned(),
                reason,
            },
            WikiIndexFailure::EmbeddingUnavailable { reason } => WikiFailure::IndexUnavailable {
                backend: "embedding".to_owned(),
                reason,
            },
        }
    }
}

pub trait WikiVectorIndex: Send + Sync {
    fn embed_page<'a>(
        &'a self,
        project_root: &'a Path,
        relative_path: &'a str,
        title: &'a str,
        revision: &'a WikiRevision,
        chunks: &'a [WikiChunk],
        config: &'a EmbeddingConfig,
        credentials: &'a EmbeddingCredentials,
    ) -> WikiIndexFuture<'a, Result<(), WikiIndexFailure>>;

    fn prepare_page<'a>(
        &'a self,
        relative_path: &'a str,
        title: &'a str,
        revision: &'a WikiRevision,
        chunks: &'a [WikiChunk],
        config: &'a EmbeddingConfig,
        credentials: &'a EmbeddingCredentials,
        http_slots: &'a tokio::sync::Semaphore,
    ) -> WikiIndexFuture<'a, Result<PreparedPageEmbedding, WikiIndexFailure>>;

    fn replace_pages<'a>(
        &'a self,
        project_root: &'a Path,
        pages: Vec<PreparedPageEmbedding>,
    ) -> WikiIndexFuture<'a, Result<usize, WikiIndexFailure>>;

    fn update_pages<'a>(
        &'a self,
        project_root: &'a Path,
        pages: Vec<PreparedPageEmbedding>,
        on_written: &'a (dyn Fn(usize) + Send + Sync),
    ) -> WikiIndexFuture<'a, (usize, Option<WikiIndexFailure>)>;

    fn search<'a>(
        &'a self,
        project_root: &'a Path,
        query: &'a str,
        limit: usize,
        include_content: bool,
        config: &'a EmbeddingConfig,
        credentials: &'a EmbeddingCredentials,
    ) -> WikiIndexFuture<'a, Result<WikiSearchReceipt, WikiFailure>>;

    fn retrieve_context<'a>(
        &'a self,
        project_root: &'a Path,
        input: &'a WikiRetrieveContextInput,
        config: &'a EmbeddingConfig,
        credentials: &'a EmbeddingCredentials,
    ) -> WikiIndexFuture<'a, Result<WikiSearchReceipt, WikiFailure>> {
        self.search(
            project_root,
            &input.query,
            input.limit,
            true,
            config,
            credentials,
        )
    }
}

pub struct RemoteWikiVectorIndex {
    embedder: Embedder,
}

impl RemoteWikiVectorIndex {
    pub fn new() -> Result<Self, WikiIndexFailure> {
        Ok(Self {
            embedder: Embedder::new().map_err(WikiIndexFailure::embedding)?,
        })
    }

    async fn prepare_rows(
        &self,
        title: &str,
        chunks: &[WikiChunk],
        config: &EmbeddingConfig,
        credentials: &EmbeddingCredentials,
        http_slots: Option<&tokio::sync::Semaphore>,
    ) -> Result<Vec<ChunkEmbedding>, WikiIndexFailure> {
        let batch_size = config.batch_size.clamp(1, 64);
        let concurrency = config.concurrency.clamp(1, 32);
        let batches = 0..chunks.len().div_ceil(batch_size);
        let rows = stream::iter(batches)
            .map(|batch_index| async move {
                let start = batch_index * batch_size;
                let batch = &chunks[start..(start + batch_size).min(chunks.len())];
                let texts = batch
                    .iter()
                    .map(|chunk| enrich_chunk(title, chunk))
                    .collect::<Vec<_>>();
                let vectors = if texts.len() > 1 && supports_batch(config) {
                    let batch_result = {
                        let _permit = match http_slots {
                            Some(slots) => {
                                Some(slots.acquire().await.expect("embedding HTTP slots open"))
                            }
                            None => None,
                        };
                        self.embedder.embed_batch(&texts, config, credentials).await
                    };
                    match batch_result {
                        Ok(vectors) => vectors,
                        Err(_) => {
                            eprintln!("[WikiEmbedding] batch_failed_retry_individual");
                            let mut vectors = Vec::with_capacity(texts.len());
                            for text in &texts {
                                let _permit = match http_slots {
                                    Some(slots) => Some(
                                        slots.acquire().await.expect("embedding HTTP slots open"),
                                    ),
                                    None => None,
                                };
                                vectors.push(
                                    self.embedder
                                        .embed(text, config, credentials, 3)
                                        .await
                                        .map_err(WikiIndexFailure::embedding)?,
                                );
                            }
                            vectors
                        }
                    }
                } else {
                    let mut vectors = Vec::with_capacity(texts.len());
                    for text in &texts {
                        let _permit = match http_slots {
                            Some(slots) => {
                                Some(slots.acquire().await.expect("embedding HTTP slots open"))
                            }
                            None => None,
                        };
                        vectors.push(
                            self.embedder
                                .embed(text, config, credentials, 3)
                                .await
                                .map_err(WikiIndexFailure::embedding)?,
                        );
                    }
                    vectors
                };
                Ok::<_, WikiIndexFailure>(
                    batch
                        .iter()
                        .zip(vectors)
                        .enumerate()
                        .map(|(offset, (chunk, embedding))| ChunkEmbedding {
                            chunk_index: (batch_index * batch_size + offset) as u32,
                            chunk_text: chunk.text().to_owned(),
                            heading_path: chunk.heading_path().to_owned(),
                            embedding,
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .buffer_unordered(concurrency)
            .try_collect::<Vec<_>>()
            .await?;
        let mut rows = rows.into_iter().flatten().collect::<Vec<_>>();
        rows.sort_unstable_by_key(|row| row.chunk_index);
        let dimension = rows.first().map(|row| row.embedding.len()).unwrap_or(0);
        if dimension == 0 || rows.iter().any(|row| row.embedding.len() != dimension) {
            return Err(WikiIndexFailure::embedding(
                "embedding provider returned empty or inconsistent vector dimensions",
            ));
        }
        Ok(rows)
    }
}

impl WikiVectorIndex for RemoteWikiVectorIndex {
    fn embed_page<'a>(
        &'a self,
        project_root: &'a Path,
        relative_path: &'a str,
        title: &'a str,
        revision: &'a WikiRevision,
        chunks: &'a [WikiChunk],
        config: &'a EmbeddingConfig,
        credentials: &'a EmbeddingCredentials,
    ) -> WikiIndexFuture<'a, Result<(), WikiIndexFailure>> {
        Box::pin(async move {
            if !config.enabled
                || config.endpoint.trim().is_empty()
                || config.model.trim().is_empty()
            {
                return Err(WikiIndexFailure::embedding(
                    "wiki embedding is disabled or not configured",
                ));
            }
            if chunks.is_empty() {
                return Err(WikiIndexFailure::embedding(
                    "wiki page has no indexable content",
                ));
            }
            if chunks.len() > 512 {
                return Err(WikiIndexFailure::embedding(
                    "wiki page exceeds the 512 chunk limit; increase maxChunkChars or split the page",
                ));
            }
            let page_id = page_id(relative_path);
            let fingerprint = embedding_fingerprint(revision, title, config, credentials);
            if vector::page_revision_matches(project_root, &page_id, &fingerprint)
                .await
                .map_err(WikiIndexFailure::lancedb)?
            {
                return Ok(());
            }
            // Provider cancellation precedes the atomic page replacement; old vectors remain on failure.
            let rows = tokio::time::timeout(
                Duration::from_secs(300),
                self.prepare_rows(title, chunks, config, credentials, None),
            )
            .await
            .map_err(|_| {
                WikiIndexFailure::embedding("wiki embedding provider timed out after 300 seconds")
            })??;
            vector::upsert_page_chunks(project_root, &page_id, rows, &fingerprint)
                .await
                .map_err(WikiIndexFailure::lancedb)
        })
    }

    fn prepare_page<'a>(
        &'a self,
        relative_path: &'a str,
        title: &'a str,
        revision: &'a WikiRevision,
        chunks: &'a [WikiChunk],
        config: &'a EmbeddingConfig,
        credentials: &'a EmbeddingCredentials,
        http_slots: &'a tokio::sync::Semaphore,
    ) -> WikiIndexFuture<'a, Result<PreparedPageEmbedding, WikiIndexFailure>> {
        Box::pin(async move {
            if chunks.is_empty() || chunks.len() > 512 {
                return Err(WikiIndexFailure::embedding(
                    "wiki page must contain between 1 and 512 chunks",
                ));
            }
            let rows = tokio::time::timeout(
                Duration::from_secs(300),
                self.prepare_rows(title, chunks, config, credentials, Some(http_slots)),
            )
            .await
            .map_err(|_| {
                WikiIndexFailure::embedding("wiki embedding provider timed out after 300 seconds")
            })??;
            Ok(PreparedPageEmbedding {
                page_id: page_id(relative_path),
                fingerprint: embedding_fingerprint(revision, title, config, credentials),
                rows,
            })
        })
    }

    fn replace_pages<'a>(
        &'a self,
        project_root: &'a Path,
        pages: Vec<PreparedPageEmbedding>,
    ) -> WikiIndexFuture<'a, Result<usize, WikiIndexFailure>> {
        Box::pin(async move {
            vector::replace_pages(project_root, pages)
                .await
                .map_err(WikiIndexFailure::lancedb)
        })
    }

    fn update_pages<'a>(
        &'a self,
        project_root: &'a Path,
        pages: Vec<PreparedPageEmbedding>,
        on_written: &'a (dyn Fn(usize) + Send + Sync),
    ) -> WikiIndexFuture<'a, (usize, Option<WikiIndexFailure>)> {
        Box::pin(async move {
            let (count, failure) = vector::update_pages(project_root, pages, on_written).await;
            (count, failure.map(WikiIndexFailure::lancedb))
        })
    }

    fn search<'a>(
        &'a self,
        project_root: &'a Path,
        query: &'a str,
        limit: usize,
        include_content: bool,
        config: &'a EmbeddingConfig,
        credentials: &'a EmbeddingCredentials,
    ) -> WikiIndexFuture<'a, Result<WikiSearchReceipt, WikiFailure>> {
        Box::pin(async move {
            if query.trim().is_empty() {
                return Err(WikiFailure::invalid_input("query", "query is required"));
            }
            let limit = limit.clamp(1, 50);
            let pages = load_search_pages(project_root)?;
            let mut hits = keyword_hits(&pages, query, include_content)?;
            let token_hits = hits.len();
            let vectors = if config.enabled
                && !config.endpoint.trim().is_empty()
                && !config.model.trim().is_empty()
            {
                match self.embedder.embed(query, config, credentials, 0).await {
                    Ok(embedding) => {
                        match vector::search_pages(project_root, embedding, limit.max(10)).await {
                            Ok(results) => results,
                            Err(_) => {
                                eprintln!(
                                    "[WikiSearch] vector_search_failed_keyword_graph_retained"
                                );
                                Vec::new()
                            }
                        }
                    }
                    Err(_) => {
                        eprintln!("[WikiSearch] query_embedding_failed_keyword_graph_retained");
                        Vec::new()
                    }
                }
            } else {
                Vec::new()
            };
            let vector_hits = vectors.len();
            if vector_hits > 0 {
                fuse_results(&pages, &mut hits, vectors, include_content);
            }
            hits.sort_unstable_by(|a, b| {
                b.score
                    .total_cmp(&a.score)
                    .then(a.relative_path.cmp(&b.relative_path))
            });
            Ok(finish_search(
                &pages,
                query,
                hits,
                limit,
                token_hits,
                vector_hits,
                include_content,
            ))
        })
    }
}

fn fuse_results(
    pages: &[SearchPage],
    hits: &mut Vec<WikiSearchHit>,
    vectors: Vec<PageSearchResult>,
    include_content: bool,
) {
    hits.sort_unstable_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.relative_path.cmp(&b.relative_path))
    });
    let mut hit_indexes = HashMap::with_capacity(hits.len());
    for (index, hit) in hits.iter_mut().enumerate() {
        hit.score = 1.0 / (60.0 + (index + 1) as f64);
        hit_indexes.insert(hit.relative_path.clone(), index);
    }
    let pages_by_id = pages
        .iter()
        .map(|page| (page_id(&page.relative_path), page))
        .collect::<HashMap<_, _>>();
    for (index, vector) in vectors.into_iter().enumerate() {
        let Some(page) = pages_by_id.get(&vector.page_id) else {
            continue;
        };
        let score = 1.0 / (60.0 + (index + 1) as f64);
        if let Some(index) = hit_indexes.get(&page.relative_path) {
            hits[*index].score += score;
            hits[*index].vector_score = Some(vector.score);
            continue;
        }
        let mut hit = WikiSearchHit::new(
            page.relative_path.clone(),
            page.title.clone(),
            score,
            vec![vector_snippet(&vector)],
        );
        hit.vector_score = Some(vector.score);
        hit.images = extract_search_images(&page.content);
        hit.content = include_content.then(|| page.content.clone());
        hits.push(hit);
    }
}

fn vector_snippet(result: &PageSearchResult) -> String {
    let text = result.chunk_text.trim().replace('\n', " ");
    if text.is_empty() {
        return String::new();
    }
    let snippet = text.chars().take(160).collect::<String>();
    let suffix = if text.chars().count() > 160 {
        "..."
    } else {
        ""
    };
    let heading = result.heading_path.trim();
    if heading.is_empty() {
        format!("{snippet}{suffix}")
    } else {
        format!("{heading}: {snippet}{suffix}")
    }
}

fn enrich_chunk(title: &str, chunk: &WikiChunk) -> String {
    [
        title.trim(),
        chunk.heading_path().trim(),
        chunk.text().trim(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}

fn page_id(relative_path: &str) -> String {
    stable_content_hash(relative_path.as_bytes())
}

fn embedding_fingerprint(
    revision: &WikiRevision,
    title: &str,
    config: &EmbeddingConfig,
    credentials: &EmbeddingCredentials,
) -> String {
    let signature = serde_json::json!({
        "revision": revision.id(),
        "title": title,
        "endpoint": config.endpoint.trim(),
        "model": config.model.trim(),
        "outputDimensionality": config.output_dimensionality,
        "extraHeaders": config.extra_headers,
        "privateHeaders": credentials.extra_headers,
        "maxChunkChars": config.max_chunk_chars,
        "overlapChunkChars": config.overlap_chunk_chars,
    });
    stable_content_hash(signature.to_string().as_bytes())
}
