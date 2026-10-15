use std::path::PathBuf;

use crate::{
    WikiFailure, WikiPathSelector, WikiReadInput,
    domain::{chunk_markdown_with_overlap, extract_search_title, stable_content_hash},
    index::PreparedPageEmbedding,
    search_config::{EmbeddingConfig, EmbeddingCredentials},
    vector::PageIndexRevision,
};

use super::actor::{WikiShared, WikiState, project_root, read_file, selected_project};

pub(crate) struct PageEmbeddingPlan {
    pub project_id: String,
    root: PathBuf,
    path: String,
    revision: String,
    config: EmbeddingConfig,
    credentials: EmbeddingCredentials,
    index_revision: PageIndexRevision,
    page: Option<PreparedPageEmbedding>,
}

pub(crate) async fn prepare_page(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiPathSelector,
) -> Result<PageEmbeddingPlan, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let root = project_root(project);
    let read = read_file(
        state,
        WikiReadInput {
            project_id: Some(project.project_id().to_owned()),
            relative_path: input.relative_path.clone(),
            limit: 0,
        },
    )?;
    let (config, credentials) = crate::search_config::embedding_execution_config(
        root,
        &state.state_root,
        project.project_id(),
    )?;
    if !config.is_ready() {
        return Err(WikiFailure::IndexUnavailable {
            backend: "embedding".to_owned(),
            reason: if !config.enabled {
                "wiki embedding is disabled"
            } else {
                "wiki embedding is not configured"
            }
            .to_owned(),
        });
    }
    let title = extract_search_title(
        read.content(),
        std::path::Path::new(&input.relative_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&input.relative_path),
    );
    let chunks = chunk_markdown_with_overlap(
        &input.relative_path,
        read.content(),
        config.max_chunk_chars,
        config.overlap_chunk_chars,
    );
    if chunks.is_empty() || chunks.len() > 512 {
        return Err(WikiFailure::IndexUnavailable {
            backend: "embedding".to_owned(),
            reason: if chunks.is_empty() {
                "wiki page has no indexable content"
            } else {
                "wiki page exceeds the 512 chunk limit; increase maxChunkChars or split the page"
            }
            .to_owned(),
        });
    }
    let page_id = crate::index::page_id(&input.relative_path);
    let index_revision = crate::vector::page_index_revision(root, &page_id)
        .await
        .map_err(|reason| WikiFailure::IndexUnavailable {
            backend: "lancedb".to_owned(),
            reason,
        })?;
    let space_key = crate::index::embedding_space_key(&config);
    let fingerprint =
        crate::index::embedding_fingerprint(read.revision(), &title, &config, &space_key);
    let current = crate::vector::page_revision_matches(root, &page_id, &fingerprint, &space_key)
        .await
        .map_err(|reason| WikiFailure::IndexUnavailable {
            backend: "lancedb".to_owned(),
            reason,
        })?;
    let page = if current {
        None
    } else {
        let slots = tokio::sync::Semaphore::new(config.concurrency.clamp(1, 32));
        Some(
            shared
                .vector_index
                .prepare_page(
                    &input.relative_path,
                    &title,
                    read.revision(),
                    &chunks,
                    &config,
                    &credentials,
                    &slots,
                )
                .await
                .map_err(WikiFailure::from)?,
        )
    };
    Ok(PageEmbeddingPlan {
        project_id: project.project_id().to_owned(),
        root: root.to_path_buf(),
        path: input.relative_path,
        revision: read.revision().id().to_owned(),
        config,
        credentials,
        index_revision,
        page,
    })
}

// Called only by Commit(project_id), including automatic embedding already running in that lane.
pub(crate) async fn commit_page(
    shared: &WikiShared,
    state: &WikiState,
    plan: PageEmbeddingPlan,
) -> Result<(), WikiFailure> {
    let project = selected_project(state, Some(&plan.project_id))?;
    let root = project_root(project);
    let (config, credentials) = crate::search_config::embedding_execution_config(
        root,
        &state.state_root,
        project.project_id(),
    )?;
    let current = std::fs::read(crate::domain::resolve_project_path(root, &plan.path)?).ok();
    if root != plan.root
        || config != plan.config
        || credentials != plan.credentials
        || current.as_deref().map(stable_content_hash).as_deref() != Some(plan.revision.as_str())
        || crate::vector::page_index_revision(root, &crate::index::page_id(&plan.path))
            .await
            .map_err(|reason| WikiFailure::IndexUnavailable {
                backend: "lancedb".to_owned(),
                reason,
            })?
            != plan.index_revision
    {
        return Err(WikiFailure::state(
            "Wiki page or index changed during embedding; retry explicitly",
        ));
    }
    let Some(mut page) = plan.page else {
        return Ok(());
    };
    page.commit_guard = Some(std::sync::Arc::new(crate::vector::IndexCommitGuard::Page {
        path: plan.path,
        revision: plan.revision,
        index_revision: plan.index_revision,
    }));
    shared
        .vector_index
        .update_pages(root, vec![page], &|_| {})
        .await
        .1
        .map_or(Ok(()), |failure| Err(failure.into()))
}
