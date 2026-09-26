use std::{future::Future, path::Path, pin::Pin, sync::Arc};

use serde::{Deserialize, Serialize};

use crate::{
    domain::{
        WikiChunk, WikiFailure, WikiRetrieveContextInput, WikiRevision, WikiSearchHit,
        WikiSearchReceipt, stable_content_hash,
    },
    embedding::Embedder,
    vector::{self, ChunkEmbedding},
};

type WikiIndexFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WikiIndexFailure {
    LanceDbUnavailable { reason: String },
    MiniLmUnavailable { reason: String },
}

impl WikiIndexFailure {
    pub fn lancedb(reason: impl Into<String>) -> Self {
        Self::LanceDbUnavailable {
            reason: reason.into(),
        }
    }

    pub fn minilm(reason: impl Into<String>) -> Self {
        Self::MiniLmUnavailable {
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
            WikiIndexFailure::MiniLmUnavailable { reason } => WikiFailure::IndexUnavailable {
                backend: "minilm".to_owned(),
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
        revision: &'a WikiRevision,
        chunks: &'a [WikiChunk],
    ) -> WikiIndexFuture<'a, Result<(), WikiIndexFailure>>;

    fn retrieve_context<'a>(
        &'a self,
        project_root: &'a Path,
        input: &'a WikiRetrieveContextInput,
        keyword_fallback: WikiSearchReceipt,
    ) -> WikiIndexFuture<'a, Result<WikiSearchReceipt, WikiIndexFailure>>;
}

#[derive(Default)]
pub struct UnavailableWikiVectorIndex;

impl WikiVectorIndex for UnavailableWikiVectorIndex {
    fn embed_page<'a>(
        &'a self,
        _project_root: &'a Path,
        _relative_path: &'a str,
        _revision: &'a WikiRevision,
        _chunks: &'a [WikiChunk],
    ) -> WikiIndexFuture<'a, Result<(), WikiIndexFailure>> {
        Box::pin(async {
            Err(WikiIndexFailure::lancedb(
                "wiki vector index is unavailable",
            ))
        })
    }

    fn retrieve_context<'a>(
        &'a self,
        _project_root: &'a Path,
        _input: &'a WikiRetrieveContextInput,
        _keyword_fallback: WikiSearchReceipt,
    ) -> WikiIndexFuture<'a, Result<WikiSearchReceipt, WikiIndexFailure>> {
        Box::pin(async {
            Err(WikiIndexFailure::minilm(
                "wiki embedding model is unavailable",
            ))
        })
    }
}

pub struct LocalWikiVectorIndex {
    embedder: Arc<Embedder>,
}

impl LocalWikiVectorIndex {
    pub fn load_default() -> Result<Self, WikiIndexFailure> {
        let model_dir = std::env::var_os("MATCHA_WIKI_MINILM_MODEL_DIR")
            .map(Into::into)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../..")
                    .join("packages/memory-lancedb-pro/models/Xenova/all-MiniLM-L6-v2")
            });
        Self::load(model_dir)
    }

    pub fn load(model_dir: std::path::PathBuf) -> Result<Self, WikiIndexFailure> {
        Ok(Self {
            embedder: Arc::new(Embedder::load(model_dir).map_err(WikiIndexFailure::minilm)?),
        })
    }
}

impl WikiVectorIndex for LocalWikiVectorIndex {
    fn embed_page<'a>(
        &'a self,
        project_root: &'a Path,
        relative_path: &'a str,
        revision: &'a WikiRevision,
        chunks: &'a [WikiChunk],
    ) -> WikiIndexFuture<'a, Result<(), WikiIndexFailure>> {
        Box::pin(async move {
            let texts = chunks
                .iter()
                .map(|chunk| chunk.text().to_owned())
                .collect::<Vec<_>>();
            let vectors = self
                .embedder
                .embed_batch(&texts)
                .map_err(WikiIndexFailure::minilm)?;
            let embeddings = chunks
                .iter()
                .zip(vectors)
                .enumerate()
                .map(|(index, (chunk, embedding))| ChunkEmbedding {
                    chunk_index: index as u32,
                    chunk_text: chunk.text().to_owned(),
                    heading_path: relative_path.to_owned(),
                    embedding,
                })
                .collect::<Vec<_>>();
            vector::upsert_page_chunks(
                project_root,
                &page_id(relative_path),
                embeddings,
                revision.id(),
            )
            .await
            .map_err(WikiIndexFailure::lancedb)
        })
    }

    fn retrieve_context<'a>(
        &'a self,
        project_root: &'a Path,
        input: &'a WikiRetrieveContextInput,
        keyword_fallback: WikiSearchReceipt,
    ) -> WikiIndexFuture<'a, Result<WikiSearchReceipt, WikiIndexFailure>> {
        Box::pin(async move {
            let embedding = self
                .embedder
                .embed(&input.query)
                .map_err(WikiIndexFailure::minilm)?;
            let results = vector::search_chunks(project_root, embedding, input.limit.max(1))
                .await
                .map_err(WikiIndexFailure::lancedb)?;
            if results.is_empty() {
                return Ok(keyword_fallback);
            }
            Ok(WikiSearchReceipt::new(
                input.query.clone(),
                results
                    .into_iter()
                    .map(|result| {
                        WikiSearchHit::new(
                            result.heading_path,
                            result.page_id,
                            (result.score * 1000.0) as usize,
                            vec![result.chunk_text],
                        )
                    })
                    .collect(),
            ))
        })
    }
}

fn page_id(relative_path: &str) -> String {
    stable_content_hash(relative_path.as_bytes())
}
