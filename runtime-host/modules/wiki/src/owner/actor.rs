use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    io::{Cursor, Read as _},
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use foundation::execution::{LaneRetention, OwnerSpec};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::{
    application::commands::{
        WikiCommand, WikiImportFolderPlan, WikiOwnerKey, WikiParsedImportImage,
        WikiParsedImportSource, WikiQuery, WikiRefreshSourcesPlan, WikiStagedImportSource,
    },
    domain::{
        RAW_SOURCES_DIR, WIKI_MEDIA_DIR, WIKI_SOURCES_DIR, WikiApplyGeneratedPagesInput,
        WikiApplyGeneratedPagesReceipt, WikiCancelSourceTaskInput, WikiCreateProjectInput,
        WikiDeleteSourceInput, WikiDeleteSourceReceipt, WikiFailure, WikiFileEntry, WikiFilesInput,
        WikiFilesReceipt, WikiImportFolderInput, WikiImportSourceInput, WikiImportSourceReceipt,
        WikiOpenProjectInput, WikiPathSelector, WikiProjectRecord, WikiProjectRegistry,
        WikiProjectSelector, WikiProjectTemplatesReceipt, WikiProjectView, WikiProjectsReceipt,
        WikiReadBinaryInput, WikiReadBinaryReceipt, WikiReadInput, WikiReadReceipt,
        WikiReorderSourceTaskInput, WikiRetrieveContextInput, WikiReviewClearResolvedInput,
        WikiReviewDismissInput, WikiReviewResolveInput, WikiReviewsReceipt, WikiRevision,
        WikiSearchInput, WikiSearchReceipt, WikiSourceFilesReceipt, WikiSourceMoveReceipt,
        WikiSourceSkip, WikiSourceTaskActionInput, WikiSourceTaskKind, WikiSourceTasksReceipt,
        WikiSourceWatchConfig, WikiSourceWatchConfigInput, WikiSourceWatchConfigReceipt,
        WikiStatusReceipt, WikiWriteInput, WikiWriteReceipt, absolute_clean_path, build_graph,
        chunk_markdown, ensure_project_layout, ensure_project_layout_for_template, keyword_search,
        layout_status, normalize_relative_path, now_ms, project_id_for_root,
        project_template_or_default, project_template_views, resolve_project_path,
        stable_content_hash, system_time_ms, title_for_root,
    },
    index::{UnavailableWikiVectorIndex, WikiVectorIndex},
    ports::{WikiIngestImageCaptionRequest, WikiIngestLlm, WikiIngestLlmOptions},
};

use super::{
    source_lifecycle::{
        self, DEFAULT_WATCH_MAX_BYTES, SourceCacheEntry, append_source_task_paths,
        append_source_tasks, cleanup_deleted_wiki_pages, collect_regular_files,
        identify_source_moves, is_default_watch_allowed_source_path, is_default_watch_descend_dir,
        is_default_watch_tracked_file, is_deleted_raw_source_path, is_deleted_wiki_page_path,
        is_ingestable_source_path, is_sensitive_config_source_file, mark_source_task_cancelled,
        mark_source_task_done, mark_source_task_running, read_source_cache, refresh_file_snapshot,
        request_source_task_cancel, source_content_hash, source_identity, source_summary_slug,
        source_task_cancel_requested, source_task_paused, staged_raw_source,
        write_source_cache_entry,
    },
    source_watcher::SourceWatchControl,
};

const PROJECT_REGISTRY_FILE: &str = "project-registry.json";
const CURRENT_PROJECT_FILE: &str = "current-project.json";
const SOURCE_WATCH_CONFIG_FILE: &str = ".llm-wiki/source-watch-config.json";
const MINERU_PRIVATE_CONFIG_FILE: &str = "mineru-private-config.json";
const IMAGE_CAPTION_CACHE_FILE: &str = ".llm-wiki/image-caption-cache.json";
const MINERU_API_BASE: &str = "https://mineru.net/api/v4";
const MINERU_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);
const MINERU_CLOUD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
const MINERU_LOCAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3600);
const MINERU_MAX_BYTES: u64 = 200 * 1024 * 1024;
const FILE_SNAPSHOT: &str = ".llm-wiki/file-snapshot.json";
const FILE_CHANGE_QUEUE: &str = ".llm-wiki/file-change-queue.json";

pub struct WikiOwnerInput {
    pub runtime_state_dir: PathBuf,
    pub vector_index: Option<Arc<dyn WikiVectorIndex>>,
    pub ingest_llm: Option<Arc<dyn WikiIngestLlm>>,
}

impl WikiOwnerInput {
    pub fn new(runtime_state_dir: PathBuf) -> Self {
        Self {
            runtime_state_dir,
            vector_index: None,
            ingest_llm: None,
        }
    }

    pub fn with_vector_index(mut self, vector_index: Option<Arc<dyn WikiVectorIndex>>) -> Self {
        self.vector_index = vector_index;
        self
    }

    pub fn with_ingest_llm(mut self, ingest_llm: Option<Arc<dyn WikiIngestLlm>>) -> Self {
        self.ingest_llm = ingest_llm;
        self
    }
}

#[derive(Clone)]
pub(crate) struct WikiShared {
    vector_index: Arc<dyn WikiVectorIndex>,
    ingest_llm: Option<Arc<dyn WikiIngestLlm>>,
    state: Arc<RwLock<WikiState>>,
    source_watch_control: SourceWatchControl,
    source_task_cancellations: Arc<Mutex<BTreeMap<SourceTaskKey, CancellationToken>>>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct SourceTaskKey {
    project_id: String,
    source_relative_path: String,
}

#[derive(Clone)]
pub(crate) struct WikiState {
    state_root: PathBuf,
    registry: WikiProjectRegistry,
    current_project_id: Option<String>,
}

impl WikiShared {
    async fn snapshot(&self) -> WikiState {
        self.state.read().await.clone()
    }

    async fn reset_source_task_cancellation(
        &self,
        project_id: &str,
        source_relative_path: &str,
    ) -> CancellationToken {
        let token = CancellationToken::new();
        self.source_task_cancellations.lock().await.insert(
            source_task_key(project_id, source_relative_path),
            token.clone(),
        );
        token
    }

    async fn source_task_cancellation(
        &self,
        project_id: &str,
        source_relative_path: &str,
    ) -> CancellationToken {
        let key = source_task_key(project_id, source_relative_path);
        let mut cancellations = self.source_task_cancellations.lock().await;
        cancellations
            .entry(key)
            .or_insert_with(CancellationToken::new)
            .clone()
    }

    async fn cancel_source_task_token(&self, project_id: &str, source_relative_path: &str) {
        self.source_task_cancellation(project_id, source_relative_path)
            .await
            .cancel();
    }

    async fn clear_source_task_cancellation(&self, project_id: &str, source_relative_path: &str) {
        self.source_task_cancellations
            .lock()
            .await
            .remove(&source_task_key(project_id, source_relative_path));
    }
}

fn source_task_key(project_id: &str, source_relative_path: &str) -> SourceTaskKey {
    SourceTaskKey {
        project_id: project_id.to_owned(),
        source_relative_path: source_relative_path.to_owned(),
    }
}

pub(crate) struct WikiGlobalState;

pub(crate) struct WikiLaneState;

pub(crate) struct WikiOwner {
    shared: WikiShared,
    global: WikiGlobalState,
}

impl WikiOwner {
    pub(crate) fn new(
        input: WikiOwnerInput,
        source_watch_control: SourceWatchControl,
    ) -> Result<Self, WikiFailure> {
        let state_root = input.runtime_state_dir.join("wiki");
        std::fs::create_dir_all(&state_root)
            .map_err(|error| WikiFailure::io(path_text(&state_root), error))?;
        let registry = read_json(state_root.join(PROJECT_REGISTRY_FILE))?;
        let current = read_json::<CurrentProjectFile>(state_root.join(CURRENT_PROJECT_FILE))?;
        Ok(Self {
            shared: WikiShared {
                vector_index: input
                    .vector_index
                    .unwrap_or_else(|| Arc::new(UnavailableWikiVectorIndex)),
                ingest_llm: input.ingest_llm,
                state: Arc::new(RwLock::new(WikiState {
                    state_root,
                    registry,
                    current_project_id: current.project_id,
                })),
                source_watch_control,
                source_task_cancellations: Arc::new(Mutex::new(BTreeMap::new())),
            },
            global: WikiGlobalState,
        })
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for WikiOwner {
    type Command = WikiCommand;
    type Query = WikiQuery;
    type Key = WikiOwnerKey;
    type Shared = WikiShared;
    type GlobalState = WikiGlobalState;
    type LaneState = WikiLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, self.global)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        WikiLaneState
    }

    async fn handle_keyed_command(
        shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        command: Self::Command,
    ) {
        handle_project_command(shared, command).await;
    }

    async fn handle_global_command(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            WikiCommand::CreateProject { input, reply } => {
                let _ = reply.send(create_project(&shared, input).await);
            }
            WikiCommand::OpenProject { input, reply } => {
                let _ = reply.send(open_project(&shared, input).await);
            }
            WikiCommand::SetCurrentProject { input, reply } => {
                let _ = reply.send(set_current_project(&shared, input).await);
            }
            WikiCommand::UpdateSourceWatchConfig { input, reply } => {
                let _ = reply.send(update_source_watch_config(&shared, input).await);
            }
            command => handle_project_command(shared, command).await,
        }
    }

    async fn handle_direct_query(shared: Self::Shared, query: Self::Query) {
        handle_query(shared, query).await;
    }

    async fn handle_keyed_query(
        shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        query: Self::Query,
    ) {
        handle_query(shared, query).await;
    }

    async fn handle_global_query(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_query(shared, query).await;
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_query(shared, query).await;
    }
}

async fn handle_project_command(shared: WikiShared, command: WikiCommand) {
    let state = shared.snapshot().await;
    match command {
        WikiCommand::WriteFile { input, reply } => {
            let _ = reply.send(write_file(&state, input));
        }
        WikiCommand::StageImportSource { input, reply } => {
            let _ = reply.send(stage_import_source(&state, input));
        }
        WikiCommand::ParseImportSource { input, reply } => {
            let _ = reply.send(parse_import_source(&shared, input).await);
        }
        WikiCommand::CommitImportSource { input, reply } => {
            let _ = reply.send(commit_import_source(&state, &shared, input).await);
        }
        WikiCommand::StageImportFolder { input, reply } => {
            let _ = reply.send(stage_import_folder(&state, input));
        }
        WikiCommand::StageRefreshSources { input, reply } => {
            let _ = reply.send(stage_refresh_sources(&state, input));
        }
        WikiCommand::StageRefreshSourcePaths {
            project_id,
            paths,
            reply,
        } => {
            let _ = reply.send(stage_refresh_source_paths(&state, &project_id, paths));
        }
        WikiCommand::CleanupDeletedWikiPages {
            project_id,
            paths,
            reply,
        } => {
            let _ = reply
                .send(cleanup_deleted_wiki_pages_for_project(&state, &project_id, &paths).await);
        }
        WikiCommand::DeleteSource { input, reply } => {
            let _ = reply.send(delete_source(&state, input).await);
        }
        WikiCommand::MigrateSourcePath {
            project_id,
            old_source_relative_path,
            new_source_relative_path,
            reply,
        } => {
            let _ = reply.send(migrate_source_path(
                &state,
                &project_id,
                &old_source_relative_path,
                &new_source_relative_path,
            ));
        }
        WikiCommand::ApplyGeneratedPages { input, reply } => {
            let _ = reply.send(apply_generated_pages(&state, &shared, input).await);
        }
        WikiCommand::ResolveReview { input, reply } => {
            let _ = reply.send(resolve_review(&state, input));
        }
        WikiCommand::DismissReview { input, reply } => {
            let _ = reply.send(dismiss_review(&state, input));
        }
        WikiCommand::ClearResolvedReviews { input, reply } => {
            let _ = reply.send(clear_resolved_reviews(&state, input));
        }
        WikiCommand::MarkSourceTaskFailed {
            project_id,
            source_relative_path,
            error,
            reply,
        } => {
            let _ = reply.send(mark_source_task_failed_for_project(
                &state,
                &project_id,
                &source_relative_path,
                error,
            ));
        }
        WikiCommand::CancelSourceTask { input, reply } => {
            let _ = reply.send(cancel_source_task(&shared, &state, input).await);
        }
        WikiCommand::RetrySourceTask { input, reply } => {
            let _ = reply.send(retry_source_task(&state, input));
        }
        WikiCommand::PauseSourceTask { input, reply } => {
            let _ = reply.send(pause_source_task(&shared, &state, input).await);
        }
        WikiCommand::ResumeSourceTask { input, reply } => {
            let _ = reply.send(resume_source_task(&state, input));
        }
        WikiCommand::ReorderSourceTask { input, reply } => {
            let _ = reply.send(reorder_source_task(&state, input));
        }
        WikiCommand::Rescan { input, reply } => {
            let _ = reply.send(rescan(&state, input));
        }
        WikiCommand::EmbedPage { input, reply } => {
            let _ = reply.send(embed_page(&shared, &state, input).await);
        }
        WikiCommand::CreateProject { input, reply } => {
            let _ = reply.send(create_project(&shared, input).await);
        }
        WikiCommand::OpenProject { input, reply } => {
            let _ = reply.send(open_project(&shared, input).await);
        }
        WikiCommand::SetCurrentProject { input, reply } => {
            let _ = reply.send(set_current_project(&shared, input).await);
        }
        WikiCommand::UpdateSourceWatchConfig { input, reply } => {
            let _ = reply.send(update_source_watch_config(&shared, input).await);
        }
    }
}

async fn handle_query(shared: WikiShared, query: WikiQuery) {
    let state = shared.snapshot().await;
    match query {
        WikiQuery::Status { reply } => {
            let _ = reply.send(status(&state));
        }
        WikiQuery::Projects { reply } => {
            let _ = reply.send(projects(&state));
        }
        WikiQuery::ProjectTemplates { reply } => {
            let _ = reply.send(project_templates());
        }
        WikiQuery::Files { input, reply } => {
            let _ = reply.send(files(&state, input));
        }
        WikiQuery::ReadFile { input, reply } => {
            let _ = reply.send(read_file(&state, input));
        }
        WikiQuery::ReadBinaryFile { input, reply } => {
            let _ = reply.send(read_binary_file(&state, input));
        }
        WikiQuery::ReadSourcePreview { input, reply } => {
            let _ = reply.send(read_source_preview(&state, input).await);
        }
        WikiQuery::Search { input, reply } => {
            let _ = reply.send(search(&state, input));
        }
        WikiQuery::Graph { input, reply } => {
            let _ = reply.send(graph(&state, input));
        }
        WikiQuery::RetrieveContext { input, reply } => {
            let _ = reply.send(retrieve_context(&shared, &state, input).await);
        }
        WikiQuery::Reviews { input, reply } => {
            let _ = reply.send(reviews(&state, input));
        }
        WikiQuery::SourceTasks { input, reply } => {
            let _ = reply.send(source_tasks(&state, input));
        }
        WikiQuery::SourceFiles { input, reply } => {
            let _ = reply.send(source_files(&state, input));
        }
        WikiQuery::SourceWatchConfig { input, reply } => {
            let _ = reply.send(source_watch_config(&state, input));
        }
    }
}

async fn create_project(
    shared: &WikiShared,
    input: WikiCreateProjectInput,
) -> Result<WikiProjectsReceipt, WikiFailure> {
    let root = normalize_root(&input.root_path)?;
    std::fs::create_dir_all(&root).map_err(|error| WikiFailure::io(path_text(&root), error))?;
    let template = project_template_or_default(input.template_id.as_deref()).ok_or_else(|| {
        WikiFailure::invalid_input(
            "templateId",
            format!(
                "unknown wiki project template: {}",
                input.template_id.as_deref().unwrap_or("")
            ),
        )
    })?;
    ensure_project_layout_for_template(&root, Some(template))
        .map_err(|error| WikiFailure::io(path_text(&root), error))?;

    let mut state = shared.state.write().await;
    let receipt = upsert_project(&mut state, &root, input.title)?;
    sync_source_watch(shared, &state);
    Ok(receipt)
}

async fn open_project(
    shared: &WikiShared,
    input: WikiOpenProjectInput,
) -> Result<WikiProjectsReceipt, WikiFailure> {
    let root = normalize_root(&input.root_path)?;
    if !root.is_dir() {
        return Err(WikiFailure::not_found(path_text(&root)));
    }
    ensure_project_layout(&root).map_err(|error| WikiFailure::io(path_text(&root), error))?;

    let mut state = shared.state.write().await;
    let receipt = upsert_project(&mut state, &root, input.title)?;
    sync_source_watch(shared, &state);
    Ok(receipt)
}

async fn set_current_project(
    shared: &WikiShared,
    input: WikiProjectSelector,
) -> Result<WikiProjectsReceipt, WikiFailure> {
    let mut state = shared.state.write().await;
    let project_id = input.project_id.ok_or(WikiFailure::CurrentProjectUnset)?;
    if state.registry.find(&project_id).is_none() {
        return Err(WikiFailure::ProjectNotFound { project_id });
    }
    state.current_project_id = Some(project_id);
    save_state(&state)?;
    let receipt = projects(&state)?;
    sync_source_watch(shared, &state);
    Ok(receipt)
}

fn status(global: &WikiState) -> Result<WikiStatusReceipt, WikiFailure> {
    let current = current_project(global).ok();
    let layout = current
        .as_ref()
        .map(|project| layout_status(project_root(project)));
    let pending_change_count = current
        .as_ref()
        .map(|project| pending_change_count(project_root(project)))
        .transpose()?
        .unwrap_or(0);
    Ok(WikiStatusReceipt::new(
        path_text(&global.state_root),
        current.as_ref().map(|project| {
            WikiProjectView::from_record(project, global.current_project_id.as_deref())
        }),
        global.registry.projects().len(),
        pending_change_count,
        layout,
    ))
}

fn projects(global: &WikiState) -> Result<WikiProjectsReceipt, WikiFailure> {
    Ok(WikiProjectsReceipt::new(
        global.current_project_id.clone(),
        global
            .registry
            .projects()
            .iter()
            .map(|project| {
                WikiProjectView::from_record(project, global.current_project_id.as_deref())
            })
            .collect(),
    ))
}

fn project_templates() -> Result<WikiProjectTemplatesReceipt, WikiFailure> {
    Ok(WikiProjectTemplatesReceipt::new(project_template_views()))
}

fn source_watch_config(
    global: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiSourceWatchConfigReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let project_id = project.project_id().to_owned();
    let config = source_watch_config_with_private_flags(
        global,
        &project_id,
        read_source_watch_config(project_root(project))?,
    )?;
    Ok(WikiSourceWatchConfigReceipt::new(project_id, config))
}

async fn update_source_watch_config(
    shared: &WikiShared,
    input: WikiSourceWatchConfigInput,
) -> Result<WikiSourceWatchConfigReceipt, WikiFailure> {
    let state = shared.snapshot().await;
    let project = selected_project(&state, input.project_id.as_deref())?;
    let project_id = project.project_id().to_owned();
    let current = read_source_watch_config(project_root(project))?;
    let config = WikiSourceWatchConfig::new(
        input.enabled.unwrap_or(current.enabled()),
        input.auto_ingest.unwrap_or(current.auto_ingest()),
        input
            .output_language
            .unwrap_or_else(|| current.output_language().to_owned()),
        input
            .generation_model_ref
            .or_else(|| current.generation_model_ref().map(str::to_owned)),
        input.caption_enabled.unwrap_or(current.caption_enabled()),
        input
            .caption_model_ref
            .or_else(|| current.caption_model_ref().map(str::to_owned)),
        input
            .caption_concurrency
            .unwrap_or_else(|| current.caption_concurrency()),
        input.mineru_enabled.unwrap_or(current.mineru_enabled()),
        input
            .mineru_backend
            .unwrap_or_else(|| current.mineru_backend().to_owned()),
        input
            .mineru_model_version
            .unwrap_or_else(|| current.mineru_model_version().to_owned()),
        input
            .mineru_local_endpoint
            .unwrap_or_else(|| current.mineru_local_endpoint().to_owned()),
        input
            .mineru_local_backend
            .unwrap_or_else(|| current.mineru_local_backend().to_owned()),
        input
            .mineru_local_effort
            .unwrap_or_else(|| current.mineru_local_effort().to_owned()),
        input
            .mineru_local_parse_method
            .unwrap_or_else(|| current.mineru_local_parse_method().to_owned()),
        input
            .mineru_local_language
            .unwrap_or_else(|| current.mineru_local_language().to_owned()),
        input
            .mineru_local_formula_enabled
            .unwrap_or_else(|| current.mineru_local_formula_enabled()),
        input
            .mineru_local_table_enabled
            .unwrap_or_else(|| current.mineru_local_table_enabled()),
        input
            .mineru_local_image_analysis
            .unwrap_or_else(|| current.mineru_local_image_analysis()),
        input
            .mineru_local_server_url
            .unwrap_or_else(|| current.mineru_local_server_url().to_owned()),
    );
    validate_source_watch_config(&config)?;
    let mut private = read_mineru_private_config(&state, &project_id)?;
    apply_private_token_input(&mut private.token, input.mineru_token);
    apply_private_token_input(&mut private.local_token, input.mineru_local_token);
    write_mineru_private_config(&state, &project_id, &private)?;
    write_source_watch_config(project_root(project), &config)?;
    if state.current_project_id.as_deref() == Some(project_id.as_str()) {
        sync_source_watch(shared, &state);
    }
    Ok(WikiSourceWatchConfigReceipt::new(
        project_id,
        config.with_mineru_private_flags(private.token.is_some(), private.local_token.is_some()),
    ))
}

fn sync_source_watch(shared: &WikiShared, state: &WikiState) {
    let Ok(project) = current_project(state) else {
        shared.source_watch_control.clear();
        return;
    };
    match read_source_watch_config(project_root(project)) {
        Ok(config) if config.enabled() => shared.source_watch_control.watch_project(
            project.project_id().to_owned(),
            project.root_path().to_owned(),
            config.auto_ingest(),
        ),
        Ok(_) => shared.source_watch_control.clear(),
        Err(error) => {
            eprintln!("[wiki] source watcher config unavailable: {error:?}");
            shared.source_watch_control.clear();
        }
    }
}

fn files(global: &WikiState, input: WikiFilesInput) -> Result<WikiFilesReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let root = project_root(project);
    let directory = resolve_project_path(root, &input.directory)?;
    if !directory.is_dir() {
        return Err(WikiFailure::not_found(path_text(&directory)));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory)
        .map_err(|error| WikiFailure::io(path_text(&directory), error))?
    {
        let entry = entry.map_err(|error| WikiFailure::io(path_text(&directory), error))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| WikiFailure::io(path_text(&path), error))?;
        let relative_path = path
            .strip_prefix(root)
            .map(crate::domain::normalize_relative_path)
            .unwrap_or_else(|_| path_text(&path));
        entries.push(WikiFileEntry::new(
            relative_path,
            metadata.is_dir(),
            metadata.len(),
            metadata.modified().map(system_time_ms).unwrap_or_default(),
        ));
    }
    entries.sort_by(|left, right| left.relative_path().cmp(right.relative_path()));
    Ok(WikiFilesReceipt::new(input.directory, entries))
}

fn source_files(
    global: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiSourceFilesReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let root = project_root(project);
    let directory = root.join(RAW_SOURCES_DIR);
    if !directory.exists() {
        return Ok(WikiSourceFilesReceipt::new(Vec::new()));
    }
    let mut paths = Vec::new();
    collect_regular_files(&directory, &mut paths)?;
    let mut entries = Vec::new();
    for path in paths {
        let metadata =
            std::fs::metadata(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
        let relative_path = path
            .strip_prefix(root)
            .map(crate::domain::normalize_relative_path)
            .unwrap_or_else(|_| path_text(&path));
        entries.push(WikiFileEntry::new(
            relative_path,
            false,
            metadata.len(),
            metadata.modified().map(system_time_ms).unwrap_or_default(),
        ));
    }
    entries.sort_by(|left, right| left.relative_path().cmp(right.relative_path()));
    Ok(WikiSourceFilesReceipt::new(entries))
}

fn read_file(global: &WikiState, input: WikiReadInput) -> Result<WikiReadReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let root = project_root(project);
    let path = resolve_project_path(root, &input.relative_path)?;
    let bytes = std::fs::read(&path).map_err(|error| map_read_error(&path, error))?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    if metadata.is_dir() {
        return Err(WikiFailure::IsDirectory {
            path: input.relative_path,
        });
    }
    let content = String::from_utf8(bytes.clone()).map_err(|_| WikiFailure::NotText {
        path: input.relative_path.clone(),
    })?;
    let visible = if input.limit == 0 {
        content
    } else {
        content.chars().take(input.limit).collect()
    };
    Ok(WikiReadReceipt::new(
        input.relative_path,
        visible,
        WikiRevision::for_bytes(
            &bytes,
            metadata.modified().map(system_time_ms).unwrap_or_default(),
        ),
    ))
}

async fn read_source_preview(
    global: &WikiState,
    input: WikiReadInput,
) -> Result<WikiReadReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let root = project_root(project);
    let path = resolve_project_path(root, &input.relative_path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| map_read_error(&path, error))?;
    if metadata.is_dir() {
        return Err(WikiFailure::IsDirectory {
            path: input.relative_path,
        });
    }
    if !is_ingestable_source_path(&input.relative_path, false) {
        return Err(WikiFailure::invalid_input(
            "path",
            "wiki source file type is not previewable",
        ));
    }
    let bytes = std::fs::read(&path).map_err(|error| map_read_error(&path, error))?;
    let content = crate::preprocess::read_source_text(path, false)
        .await
        .map_err(WikiFailure::state)?;
    let visible = if input.limit == 0 {
        content
    } else {
        content.chars().take(input.limit).collect()
    };
    Ok(WikiReadReceipt::new(
        input.relative_path,
        visible,
        WikiRevision::for_bytes(
            &bytes,
            metadata.modified().map(system_time_ms).unwrap_or_default(),
        ),
    ))
}

fn read_binary_file(
    global: &WikiState,
    input: WikiReadBinaryInput,
) -> Result<WikiReadBinaryReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let root = project_root(project);
    let path = resolve_project_path(root, &input.relative_path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| map_read_error(&path, error))?;
    if metadata.is_dir() {
        return Err(WikiFailure::IsDirectory {
            path: input.relative_path,
        });
    }
    if input.max_bytes > 0 && metadata.len() > input.max_bytes as u64 {
        return Err(WikiFailure::invalid_input(
            "maxBytes",
            "wiki file exceeds the limit",
        ));
    }
    let bytes = std::fs::read(&path).map_err(|error| map_read_error(&path, error))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(input.relative_path.as_str())
        .to_owned();
    Ok(WikiReadBinaryReceipt::new(
        name,
        B64.encode(bytes),
        metadata.len(),
    ))
}

fn write_file(global: &WikiState, input: WikiWriteInput) -> Result<WikiWriteReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let root = project_root(project);
    let path = resolve_project_path(root, &input.relative_path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    std::fs::write(&path, input.content.as_bytes())
        .map_err(|error| WikiFailure::io(path_text(&path), error))?;
    refresh_file_snapshot(root, &[input.relative_path.as_str()])?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    Ok(WikiWriteReceipt::new(
        input.relative_path,
        WikiRevision::for_bytes(
            input.content.as_bytes(),
            metadata.modified().map(system_time_ms).unwrap_or_default(),
        ),
    ))
}

fn stage_import_source(
    global: &WikiState,
    input: WikiImportSourceInput,
) -> Result<WikiStagedImportSource, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let project_id = project.project_id().to_owned();
    let root = project_root(project).to_path_buf();
    ensure_project_layout(&root).map_err(|error| WikiFailure::io(path_text(&root), error))?;

    let source_input = absolute_clean_path(&input.source_path)?;
    let source = source_input
        .canonicalize()
        .map_err(|error| map_read_error(&source_input, error))?;
    let metadata = std::fs::metadata(&source).map_err(|error| map_read_error(&source, error))?;
    if metadata.is_dir() {
        return Err(WikiFailure::IsDirectory {
            path: input.source_path,
        });
    }

    let raw_sources = root.join(RAW_SOURCES_DIR);
    let raw_sources_root = raw_sources
        .canonicalize()
        .map_err(|error| WikiFailure::io(path_text(&raw_sources), error))?;
    let (source_path, source_relative_path) =
        if let Ok(relative) = source.strip_prefix(&raw_sources_root) {
            (
                source.clone(),
                normalize_relative_path(&Path::new(RAW_SOURCES_DIR).join(relative)),
            )
        } else {
            let file_name = source.file_name().ok_or_else(|| {
                WikiFailure::invalid_input("sourcePath", "source file has no name")
            })?;
            let target = unique_import_target(&raw_sources, file_name);
            std::fs::copy(&source, &target)
                .map_err(|error| WikiFailure::io(path_text(&target), error))?;
            let relative = target
                .strip_prefix(&root)
                .map(normalize_relative_path)
                .unwrap_or_else(|_| path_text(&target));
            (target, relative)
        };

    if !is_ingestable_source_path(&source_relative_path, false) {
        return Err(WikiFailure::invalid_input(
            "sourcePath",
            "source file type is not ingestable",
        ));
    }

    let identity = source_identity(&source_relative_path).to_owned();
    let slug = source_summary_slug(&identity);
    let staged = WikiStagedImportSource {
        project_id,
        project_root: root,
        import_id: slug.clone(),
        source_path,
        source_relative_path,
        source_identity: identity,
        page_relative_path: format!("{WIKI_SOURCES_DIR}/{slug}.md"),
        task_kind: WikiSourceTaskKind::Imported,
    };
    append_source_tasks(
        &staged.project_root,
        &staged.project_id,
        std::slice::from_ref(&staged),
    )?;
    refresh_file_snapshot(
        &staged.project_root,
        &[staged.source_relative_path.as_str()],
    )?;
    Ok(staged)
}

fn stage_import_folder(
    global: &WikiState,
    input: WikiImportFolderInput,
) -> Result<WikiImportFolderPlan, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let project_id = project.project_id().to_owned();
    let root = project_root(project).to_path_buf();
    ensure_project_layout(&root).map_err(|error| WikiFailure::io(path_text(&root), error))?;
    let root_canonical = root
        .canonicalize()
        .map_err(|error| WikiFailure::io(path_text(&root), error))?;
    let folder_input = absolute_clean_path(&input.folder_path)?;
    let folder = folder_input
        .canonicalize()
        .map_err(|error| map_read_error(&folder_input, error))?;
    if !folder.is_dir() {
        return Err(WikiFailure::not_found(input.folder_path));
    }
    if folder == root_canonical || folder.starts_with(&root_canonical) {
        return Err(WikiFailure::invalid_input(
            "folderPath",
            "cannot import a folder inside the current wiki project",
        ));
    }

    let folder_name = folder
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("imported");
    let destination_root = root.join(RAW_SOURCES_DIR).join(folder_name);
    let mut imports = Vec::new();
    let mut skipped = Vec::new();
    let mut source_files = Vec::new();
    collect_regular_files(&folder, &mut source_files)?;
    source_files
        .sort_by(|left, right| normalize_relative_path(left).cmp(&normalize_relative_path(right)));
    for source in source_files {
        let relative_inside_folder = source
            .strip_prefix(&folder)
            .map(normalize_relative_path)
            .unwrap_or_else(|_| {
                source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("source")
                    .to_owned()
            });
        let destination = destination_root.join(&relative_inside_folder);
        let relative_path = normalize_relative_path(
            &Path::new(RAW_SOURCES_DIR)
                .join(folder_name)
                .join(&relative_inside_folder),
        );
        if is_sensitive_config_source_file(&source) {
            skipped.push(WikiSourceSkip::new(
                relative_inside_folder,
                "sensitive-config".to_owned(),
            ));
            continue;
        }
        if !is_default_watch_allowed_source_path(&relative_path) {
            skipped.push(WikiSourceSkip::new(
                relative_inside_folder,
                "excluded".to_owned(),
            ));
            continue;
        }
        let metadata = match std::fs::metadata(&source) {
            Ok(metadata) => metadata,
            Err(error) => {
                skipped.push(WikiSourceSkip::new(
                    relative_inside_folder,
                    error.to_string(),
                ));
                continue;
            }
        };
        if metadata.len() > DEFAULT_WATCH_MAX_BYTES {
            skipped.push(WikiSourceSkip::new(
                relative_inside_folder,
                "too-large".to_owned(),
            ));
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| WikiFailure::io(path_text(parent), error))?;
        }
        if let Err(error) = std::fs::copy(&source, &destination) {
            skipped.push(WikiSourceSkip::new(
                relative_inside_folder,
                error.to_string(),
            ));
            continue;
        }
        imports.push(staged_raw_source(
            &project_id,
            &root,
            destination,
            relative_path,
            WikiSourceTaskKind::Imported,
        )?);
    }
    append_source_tasks(root.as_path(), &project_id, &imports)?;
    let source_paths = imports
        .iter()
        .map(|import| import.source_relative_path.as_str())
        .collect::<Vec<_>>();
    refresh_file_snapshot(root.as_path(), &source_paths)?;
    Ok(WikiImportFolderPlan { imports, skipped })
}

fn stage_refresh_sources(
    global: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiRefreshSourcesPlan, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let project_id = project.project_id().to_owned();
    let root = project_root(project);
    ensure_project_layout(root).map_err(|error| WikiFailure::io(path_text(root), error))?;
    let previous = read_json::<FileSnapshot>(root.join(FILE_SNAPSHOT))?;
    let mut current = FileSnapshot::default();
    collect_snapshot_entries(root, root, &mut current.entries)?;

    let mut created_or_modified = Vec::new();
    let mut deleted = Vec::new();
    let mut wiki_deletions = Vec::new();
    let mut changes = Vec::new();
    let mut skipped = Vec::new();
    for (relative_path, entry) in &current.entries {
        match previous.entries.get(relative_path) {
            Some(previous_entry) if previous_entry.revision == entry.revision => {}
            Some(_) if is_default_watch_allowed_source_path(relative_path) => {
                changes.push(FileChange::new(
                    "modified",
                    relative_path.clone(),
                    entry.revision.clone(),
                ));
                if entry.size > DEFAULT_WATCH_MAX_BYTES {
                    skipped.push(WikiSourceSkip::new(
                        relative_path.clone(),
                        "too-large".to_owned(),
                    ));
                } else {
                    created_or_modified.push((relative_path.clone(), WikiSourceTaskKind::Modified));
                }
            }
            None if is_default_watch_allowed_source_path(relative_path) => {
                changes.push(FileChange::new(
                    "created",
                    relative_path.clone(),
                    entry.revision.clone(),
                ));
                if entry.size > DEFAULT_WATCH_MAX_BYTES {
                    skipped.push(WikiSourceSkip::new(
                        relative_path.clone(),
                        "too-large".to_owned(),
                    ));
                } else {
                    created_or_modified.push((relative_path.clone(), WikiSourceTaskKind::Created));
                }
            }
            Some(_) | None => {}
        }
    }
    for (relative_path, entry) in &previous.entries {
        if current.entries.contains_key(relative_path) {
            continue;
        }
        if is_deleted_raw_source_path(relative_path) {
            changes.push(FileChange::new(
                "deleted",
                relative_path.clone(),
                String::new(),
            ));
            deleted.push((relative_path.clone(), entry.clone()));
        } else if is_deleted_wiki_page_path(relative_path) {
            changes.push(FileChange::new(
                "deleted",
                relative_path.clone(),
                String::new(),
            ));
            wiki_deletions.push(relative_path.clone());
        }
    }

    let current_move_entries = current
        .entries
        .iter()
        .map(|(path, entry)| (path.clone(), (entry.revision.clone(), entry.size)))
        .collect::<BTreeMap<_, _>>();
    let deleted_move_entries = deleted
        .iter()
        .map(|(path, entry)| (path.clone(), entry.revision.clone(), entry.size))
        .collect::<Vec<_>>();
    let moves = identify_source_moves(
        &deleted_move_entries,
        &created_or_modified,
        &current_move_entries,
    );
    let moved_old = moves
        .iter()
        .map(|(old_path, _)| old_path.clone())
        .collect::<BTreeSet<_>>();
    let moved_new = moves
        .iter()
        .map(|(_, new_path)| new_path.clone())
        .collect::<BTreeSet<_>>();

    let mut imports = Vec::new();
    for (relative_path, task_kind) in created_or_modified {
        if moved_new.contains(&relative_path) {
            continue;
        }
        let path = root.join(&relative_path);
        match staged_raw_source(&project_id, root, path, relative_path.clone(), task_kind) {
            Ok(staged) => imports.push(staged),
            Err(error) => skipped.push(WikiSourceSkip::new(relative_path, format!("{error:?}"))),
        }
    }
    let deletions = deleted
        .into_iter()
        .map(|(relative_path, _)| relative_path)
        .filter(|relative_path| !moved_old.contains(relative_path))
        .collect::<Vec<_>>();

    append_source_tasks(root, &project_id, &imports)?;
    append_source_task_paths(root, &project_id, &deletions, WikiSourceTaskKind::Deleted)?;
    append_source_task_paths(
        root,
        &project_id,
        &moves
            .iter()
            .map(|(_, new_path)| new_path.clone())
            .collect::<Vec<_>>(),
        WikiSourceTaskKind::Moved,
    )?;
    write_json(root.join(FILE_SNAPSHOT), &current)?;
    write_json(root.join(FILE_CHANGE_QUEUE), &changes)?;
    Ok(WikiRefreshSourcesPlan {
        project_id,
        imports,
        deletions,
        wiki_deletions,
        moves,
        skipped,
    })
}

fn stage_refresh_source_paths(
    global: &WikiState,
    project_id: &str,
    paths: Vec<PathBuf>,
) -> Result<WikiRefreshSourcesPlan, WikiFailure> {
    let project = selected_project(global, Some(project_id))?;
    let project_id = project.project_id().to_owned();
    let root = project_root(project);
    ensure_project_layout(root).map_err(|error| WikiFailure::io(path_text(root), error))?;
    let previous = read_json::<FileSnapshot>(root.join(FILE_SNAPSHOT))?;
    let mut relative_paths = BTreeSet::new();
    for path in paths {
        collect_changed_snapshot_paths(root, &path, &previous, &mut relative_paths)?;
    }
    if relative_paths.is_empty() {
        return Ok(WikiRefreshSourcesPlan {
            project_id,
            imports: Vec::new(),
            deletions: Vec::new(),
            wiki_deletions: Vec::new(),
            moves: Vec::new(),
            skipped: Vec::new(),
        });
    }

    let mut snapshot = previous.clone();
    let mut created_or_modified = Vec::new();
    let mut deleted = Vec::new();
    let mut wiki_deletions = Vec::new();
    let mut changes = Vec::new();
    let mut skipped = Vec::new();
    let mut current_move_entries = BTreeMap::new();
    for relative_path in relative_paths {
        let old = previous.entries.get(&relative_path).cloned();
        let new = read_snapshot_entry(root, &relative_path)?;
        if old.as_ref().map(|entry| &entry.revision) == new.as_ref().map(|entry| &entry.revision) {
            continue;
        }
        match &new {
            Some(entry) => {
                snapshot
                    .entries
                    .insert(relative_path.clone(), entry.clone());
                current_move_entries
                    .insert(relative_path.clone(), (entry.revision.clone(), entry.size));
            }
            None => {
                snapshot.entries.remove(&relative_path);
            }
        }
        match (&old, &new) {
            (None, Some(entry)) => {
                changes.push(FileChange::new(
                    "created",
                    relative_path.clone(),
                    entry.revision.clone(),
                ));
                if is_default_watch_allowed_source_path(&relative_path) {
                    if entry.size > DEFAULT_WATCH_MAX_BYTES {
                        skipped.push(WikiSourceSkip::new(relative_path, "too-large".to_owned()));
                    } else {
                        created_or_modified.push((relative_path, WikiSourceTaskKind::Created));
                    }
                }
            }
            (Some(_), Some(entry)) => {
                changes.push(FileChange::new(
                    "modified",
                    relative_path.clone(),
                    entry.revision.clone(),
                ));
                if is_default_watch_allowed_source_path(&relative_path) {
                    if entry.size > DEFAULT_WATCH_MAX_BYTES {
                        skipped.push(WikiSourceSkip::new(relative_path, "too-large".to_owned()));
                    } else {
                        created_or_modified.push((relative_path, WikiSourceTaskKind::Modified));
                    }
                }
            }
            (Some(entry), None) => {
                changes.push(FileChange::new(
                    "deleted",
                    relative_path.clone(),
                    String::new(),
                ));
                if is_deleted_raw_source_path(&relative_path) {
                    deleted.push((relative_path, entry.clone()));
                } else if is_deleted_wiki_page_path(&relative_path) {
                    wiki_deletions.push(relative_path);
                }
            }
            (None, None) => {}
        }
    }

    let deleted_move_entries = deleted
        .iter()
        .map(|(path, entry)| (path.clone(), entry.revision.clone(), entry.size))
        .collect::<Vec<_>>();
    let moves = identify_source_moves(
        &deleted_move_entries,
        &created_or_modified,
        &current_move_entries,
    );
    let moved_old = moves
        .iter()
        .map(|(old_path, _)| old_path.clone())
        .collect::<BTreeSet<_>>();
    let moved_new = moves
        .iter()
        .map(|(_, new_path)| new_path.clone())
        .collect::<BTreeSet<_>>();

    let mut imports = Vec::new();
    for (relative_path, task_kind) in created_or_modified {
        if moved_new.contains(&relative_path) {
            continue;
        }
        let path = root.join(&relative_path);
        match staged_raw_source(&project_id, root, path, relative_path.clone(), task_kind) {
            Ok(staged) => imports.push(staged),
            Err(error) => skipped.push(WikiSourceSkip::new(relative_path, format!("{error:?}"))),
        }
    }
    let deletions = deleted
        .into_iter()
        .map(|(relative_path, _)| relative_path)
        .filter(|relative_path| !moved_old.contains(relative_path))
        .collect::<Vec<_>>();

    append_source_tasks(root, &project_id, &imports)?;
    append_source_task_paths(root, &project_id, &deletions, WikiSourceTaskKind::Deleted)?;
    append_source_task_paths(
        root,
        &project_id,
        &moves
            .iter()
            .map(|(_, new_path)| new_path.clone())
            .collect::<Vec<_>>(),
        WikiSourceTaskKind::Moved,
    )?;
    write_json(root.join(FILE_SNAPSHOT), &snapshot)?;
    write_json(root.join(FILE_CHANGE_QUEUE), &changes)?;
    Ok(WikiRefreshSourcesPlan {
        project_id,
        imports,
        deletions,
        wiki_deletions,
        moves,
        skipped,
    })
}

fn collect_changed_snapshot_paths(
    root: &Path,
    path: &Path,
    previous: &FileSnapshot,
    out: &mut BTreeSet<String>,
) -> Result<(), WikiFailure> {
    if path.is_dir() {
        let mut entries = BTreeMap::new();
        collect_snapshot_entries(root, path, &mut entries)?;
        out.extend(entries.into_keys());
        return Ok(());
    }
    if path.is_file() {
        if let Ok(relative) = path.strip_prefix(root) {
            let relative_path = normalize_relative_path(relative);
            if is_default_watch_tracked_file(&relative_path) {
                out.insert(relative_path);
            }
        }
        return Ok(());
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(());
    };
    let relative_path = normalize_relative_path(relative);
    for known in previous.entries.keys() {
        if known == &relative_path || known.starts_with(&format!("{relative_path}/")) {
            out.insert(known.clone());
        }
    }
    Ok(())
}

fn read_snapshot_entry(
    root: &Path,
    relative_path: &str,
) -> Result<Option<FileSnapshotEntry>, WikiFailure> {
    if !is_default_watch_tracked_file(relative_path) {
        return Ok(None);
    }
    let path = root.join(relative_path);
    if !path.is_file() {
        return Ok(None);
    }
    let metadata =
        std::fs::metadata(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    let bytes = std::fs::read(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    Ok(Some(FileSnapshotEntry {
        revision: stable_content_hash(&bytes),
        size: metadata.len(),
        modified_at_ms: metadata.modified().map(system_time_ms).unwrap_or_default(),
    }))
}

async fn parse_import_source(
    shared: &WikiShared,
    input: WikiStagedImportSource,
) -> Result<WikiParsedImportSource, WikiFailure> {
    let project_id = input.project_id.clone();
    let source_relative_path = input.source_relative_path.clone();
    let project_root = input.project_root.clone();
    let cancellation = shared
        .reset_source_task_cancellation(&project_id, &source_relative_path)
        .await;
    let result = parse_import_source_inner(shared, input, cancellation).await;
    if result.is_err() {
        if result.as_ref().err().is_some_and(WikiFailure::is_cancelled) {
            let _ = mark_source_task_cancelled(&project_root, &project_id, &source_relative_path);
        }
        shared
            .clear_source_task_cancellation(&project_id, &source_relative_path)
            .await;
    }
    result
}

async fn parse_import_source_inner(
    shared: &WikiShared,
    input: WikiStagedImportSource,
    cancellation: CancellationToken,
) -> Result<WikiParsedImportSource, WikiFailure> {
    reject_cancelled_source_task(&input, &cancellation)?;
    mark_source_task_running(
        &input.project_root,
        &input.project_id,
        &input.source_relative_path,
        "parse",
        20,
    )?;
    let state = shared.snapshot().await;
    let private = read_mineru_private_config(&state, &input.project_id)?;
    let config = read_source_watch_config(&input.project_root).unwrap_or_default();
    validate_ingest_model_config(&config)?;
    let parsed = read_import_source_text(&input, &config, &private, cancellation.clone()).await?;
    let images = if !parsed.images.is_empty() {
        parsed.images
    } else if let recovered @ Some(_) = recover_imported_markdown_images(&input, &parsed.markdown)?
    {
        recovered.unwrap()
    } else {
        match extract_import_images(&input, cancellation).await {
            Ok(images) => images,
            Err(error) if error.is_cancelled() => return Err(error),
            Err(error) => {
                eprintln!(
                    "[wiki] source image extraction failed; continuing with parsed text: {error:?}"
                );
                Vec::new()
            }
        }
    };
    Ok(WikiParsedImportSource {
        staged: input,
        text: parsed.markdown,
        images,
    })
}

fn validate_ingest_model_config(config: &WikiSourceWatchConfig) -> Result<(), WikiFailure> {
    if config.generation_model_ref().is_none() {
        return Err(WikiFailure::invalid_input(
            "generationModelRef",
            "Wiki generation model is not configured",
        ));
    }
    if config.caption_enabled() && config.caption_model_ref().is_none() {
        return Err(WikiFailure::invalid_input(
            "captionModelRef",
            "Wiki image caption model is not configured",
        ));
    }
    Ok(())
}

async fn read_import_source_text(
    input: &WikiStagedImportSource,
    config: &WikiSourceWatchConfig,
    private: &MineruPrivateConfig,
    cancellation: CancellationToken,
) -> Result<MineruParseResult, WikiFailure> {
    if config.mineru_enabled() && is_pdf_source(&input.source_path) {
        match parse_pdf_with_mineru(input, config, private, cancellation.clone()).await {
            Ok(result) if !result.markdown.trim().is_empty() => {
                let _ = crate::preprocess::write_source_text_cache(
                    &input.source_path,
                    &result.markdown,
                );
                return Ok(result);
            }
            Ok(_) => {}
            Err(error) if error.is_cancelled() => return Err(error),
            Err(error) => eprintln!(
                "[wiki] MinerU parse failed, falling back to built-in PDF parser: {error:?}"
            ),
        }
    }
    let markdown = tokio::select! {
        _ = cancellation.cancelled() => return Err(WikiFailure::cancelled()),
        result = crate::preprocess::read_source_text(input.source_path.clone(), false) => result.map_err(WikiFailure::state)?,
    };
    Ok(MineruParseResult {
        markdown,
        images: Vec::new(),
    })
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct MineruParseResult {
    markdown: String,
    images: Vec<WikiParsedImportImage>,
}

async fn parse_pdf_with_mineru(
    input: &WikiStagedImportSource,
    config: &WikiSourceWatchConfig,
    private: &MineruPrivateConfig,
    cancellation: CancellationToken,
) -> Result<MineruParseResult, WikiFailure> {
    let metadata = tokio::fs::metadata(&input.source_path)
        .await
        .map_err(|error| WikiFailure::io(path_text(&input.source_path), error))?;
    if metadata.len() > MINERU_MAX_BYTES {
        return Err(WikiFailure::state(
            "MinerU accurate parsing supports files up to 200 MB",
        ));
    }
    if config.mineru_backend() == "local" {
        parse_pdf_with_local_mineru(input, config, private.local_token.as_deref(), cancellation)
            .await
    } else {
        parse_pdf_with_cloud_mineru(
            input,
            config,
            private.token.as_deref(),
            mineru_source_url(input, private),
            cancellation,
        )
        .await
    }
}

async fn parse_pdf_with_cloud_mineru(
    input: &WikiStagedImportSource,
    config: &WikiSourceWatchConfig,
    token: Option<&str>,
    source_url: Option<&str>,
    cancellation: CancellationToken,
) -> Result<MineruParseResult, WikiFailure> {
    let token = token
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            WikiFailure::invalid_input("mineruToken", "MinerU API token is not configured")
        })?;
    let client = reqwest::Client::new();
    if let Some(source_url) = source_url {
        return parse_pdf_with_cloud_mineru_url(
            &client,
            source_url,
            config.mineru_model_version(),
            token,
            &input.import_id,
            cancellation,
        )
        .await;
    }
    let bytes = cancel_on_token(&cancellation, tokio::fs::read(&input.source_path))
        .await?
        .map_err(|error| WikiFailure::io(path_text(&input.source_path), error))?;
    let file_name = input
        .source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("source.pdf")
        .to_owned();
    let upload_json = serde_json::json!({
        "files": [{ "name": file_name, "data_id": file_name }],
        "model_version": config.mineru_model_version(),
    });
    let upload = mineru_send(
        &cancellation,
        client
            .post(format!("{MINERU_API_BASE}/file-urls/batch"))
            .bearer_auth(token)
            .json(&upload_json),
        "MinerU batch submit",
    )
    .await?;
    let upload = mineru_json(&cancellation, upload, "MinerU batch submit").await?;
    mineru_assert_success(&upload)?;
    let batch_id = json_string(&upload, &["data", "batch_id"])
        .ok_or_else(|| WikiFailure::state("MinerU did not return a batch ID"))?;
    let upload_url = upload
        .get("data")
        .and_then(|data| data.get("file_urls"))
        .and_then(serde_json::Value::as_array)
        .and_then(|urls| urls.first())
        .and_then(serde_json::Value::as_str)
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| WikiFailure::state("MinerU did not return a file upload URL"))?;
    mineru_send(
        &cancellation,
        client.put(upload_url).body(bytes),
        "MinerU file upload",
    )
    .await?;

    let started = std::time::Instant::now();
    let zip_url = loop {
        if started.elapsed() >= MINERU_CLOUD_TIMEOUT {
            return Err(WikiFailure::state(
                "MinerU parsing timed out after 5 minutes",
            ));
        }
        let status = mineru_send(
            &cancellation,
            client
                .get(format!(
                    "{MINERU_API_BASE}/extract-results/batch/{batch_id}"
                ))
                .bearer_auth(token),
            "MinerU batch poll",
        )
        .await?;
        let status = mineru_json(&cancellation, status, "MinerU batch poll").await?;
        mineru_assert_success(&status)?;
        let Some(result) = status
            .get("data")
            .and_then(|data| data.get("extract_result"))
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
        else {
            wait_mineru_poll(&cancellation).await?;
            continue;
        };
        match result.get("state").and_then(serde_json::Value::as_str) {
            Some("done") => {
                let url = result
                    .get("full_zip_url")
                    .and_then(serde_json::Value::as_str)
                    .filter(|url| !url.trim().is_empty())
                    .ok_or_else(|| WikiFailure::state("MinerU returned no result zip URL"))?;
                break url.to_owned();
            }
            Some("failed") => {
                return Err(WikiFailure::state(format!(
                    "MinerU parsing failed: {}",
                    result
                        .get("err_msg")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown error")
                )));
            }
            _ => wait_mineru_poll(&cancellation).await?,
        }
    };
    mineru_download_zip_result(&client, &zip_url, &input.import_id, cancellation).await
}

async fn parse_pdf_with_cloud_mineru_url(
    client: &reqwest::Client,
    source_url: &str,
    model_version: &str,
    token: &str,
    source_slug: &str,
    cancellation: CancellationToken,
) -> Result<MineruParseResult, WikiFailure> {
    let submit = mineru_send(
        &cancellation,
        client
            .post(format!("{MINERU_API_BASE}/extract/task"))
            .bearer_auth(token)
            .json(&serde_json::json!({
                "url": source_url,
                "model_version": model_version,
            })),
        "MinerU URL task submit",
    )
    .await?;
    let submit = mineru_json(&cancellation, submit, "MinerU URL task submit").await?;
    mineru_assert_success(&submit)?;
    let task_id = json_string(&submit, &["data", "task_id"])
        .or_else(|| json_string(&submit, &["data", "taskId"]))
        .ok_or_else(|| WikiFailure::state("MinerU did not return a URL task ID"))?;
    let started = std::time::Instant::now();
    let zip_url = loop {
        if started.elapsed() >= MINERU_CLOUD_TIMEOUT {
            return Err(WikiFailure::state(
                "MinerU parsing timed out after 5 minutes",
            ));
        }
        let status = mineru_send(
            &cancellation,
            client
                .get(format!(
                    "{MINERU_API_BASE}/extract/task/{}",
                    percent_encode_path_segment(&task_id)
                ))
                .bearer_auth(token),
            "MinerU URL task poll",
        )
        .await?;
        let status = mineru_json(&cancellation, status, "MinerU URL task poll").await?;
        mineru_assert_success(&status)?;
        let result = status.get("data").unwrap_or(&status);
        match result.get("state").and_then(serde_json::Value::as_str) {
            Some("done") => {
                let url = result
                    .get("full_zip_url")
                    .or_else(|| result.get("fullZipUrl"))
                    .and_then(serde_json::Value::as_str)
                    .filter(|url| !url.trim().is_empty())
                    .ok_or_else(|| WikiFailure::state("MinerU returned no result zip URL"))?;
                break url.to_owned();
            }
            Some("failed") => {
                return Err(WikiFailure::state(format!(
                    "MinerU parsing failed: {}",
                    result
                        .get("err_msg")
                        .or_else(|| result.get("error"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown error")
                )));
            }
            _ => wait_mineru_poll(&cancellation).await?,
        }
    };
    mineru_download_zip_result(client, &zip_url, source_slug, cancellation).await
}

async fn parse_pdf_with_local_mineru(
    input: &WikiStagedImportSource,
    config: &WikiSourceWatchConfig,
    token: Option<&str>,
    cancellation: CancellationToken,
) -> Result<MineruParseResult, WikiFailure> {
    let endpoint = local_mineru_api_base(config.mineru_local_endpoint())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| WikiFailure::state(format!("local MinerU client unavailable: {error}")))?;
    let configured_backend = config.mineru_local_backend();
    if configured_backend.ends_with("http-client")
        && config.mineru_local_server_url().trim().is_empty()
    {
        return Err(WikiFailure::invalid_input(
            "mineruLocalServerUrl",
            "MinerU HTTP client backends require a model server URL",
        ));
    }
    let backend = local_mineru_backend_for_version(
        configured_backend,
        local_mineru_health_version(&client, &endpoint, token, &cancellation).await?,
    );
    let bytes = cancel_on_token(&cancellation, tokio::fs::read(&input.source_path))
        .await?
        .map_err(|error| WikiFailure::io(path_text(&input.source_path), error))?;
    let file_name = input
        .source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("source.pdf")
        .to_owned();
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("application/pdf")
        .map_err(|error| WikiFailure::state(format!("invalid MinerU multipart part: {error}")))?;
    let mut form = reqwest::multipart::Form::new()
        .part("files", part)
        .text("lang_list", config.mineru_local_language().to_owned())
        .text("backend", backend)
        .text("effort", config.mineru_local_effort().to_owned())
        .text(
            "parse_method",
            config.mineru_local_parse_method().to_owned(),
        )
        .text(
            "formula_enable",
            config.mineru_local_formula_enabled().to_string(),
        )
        .text(
            "table_enable",
            config.mineru_local_table_enabled().to_string(),
        )
        .text(
            "image_analysis",
            config.mineru_local_image_analysis().to_string(),
        )
        .text("return_md", "true")
        .text("return_images", "true")
        .text("response_format_zip", "false");
    if !config.mineru_local_server_url().trim().is_empty() {
        form = form.text(
            "server_url",
            config.mineru_local_server_url().trim().to_owned(),
        );
    }
    let submit = mineru_auth(
        client.post(format!("{endpoint}/tasks")).multipart(form),
        token,
    );
    let submit = mineru_send(&cancellation, submit, "local MinerU submit").await?;
    let submit_json = mineru_json(&cancellation, submit, "local MinerU submit").await?;
    let task_id = submit_json
        .get("task_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| WikiFailure::state("local MinerU returned no task ID"))?;
    let encoded_task_id = percent_encode_path_segment(task_id);
    let status_url = format!("{endpoint}/tasks/{encoded_task_id}");
    let result_url = format!("{endpoint}/tasks/{encoded_task_id}/result");
    let started = std::time::Instant::now();
    while started.elapsed() < MINERU_LOCAL_TIMEOUT {
        let status = mineru_auth(client.get(&status_url), token);
        let status = mineru_send(&cancellation, status, "local MinerU status").await?;
        let status_json = mineru_json(&cancellation, status, "local MinerU status").await?;
        match status_json
            .get("status")
            .and_then(serde_json::Value::as_str)
        {
            Some("completed") => {
                let result = mineru_auth(client.get(&result_url), token);
                let result = mineru_send(&cancellation, result, "local MinerU result").await?;
                let result_json = mineru_json(&cancellation, result, "local MinerU result").await?;
                return local_mineru_result(&result_json, &input.import_id);
            }
            Some("failed") => {
                return Err(WikiFailure::state(format!(
                    "local MinerU parsing failed: {}",
                    status_json
                        .get("error")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown error")
                )));
            }
            _ => wait_mineru_poll(&cancellation).await?,
        }
    }
    Err(WikiFailure::state("local MinerU parsing timed out"))
}

async fn mineru_download_zip_result(
    client: &reqwest::Client,
    zip_url: &str,
    source_slug: &str,
    cancellation: CancellationToken,
) -> Result<MineruParseResult, WikiFailure> {
    let response = mineru_send(&cancellation, client.get(zip_url), "MinerU zip download").await?;
    let bytes = cancel_on_token(&cancellation, response.bytes())
        .await?
        .map_err(|error| WikiFailure::state(format!("MinerU zip download body failed: {error}")))?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| WikiFailure::state(format!("invalid MinerU result zip: {error}")))?;
    let mut markdown_entries = Vec::new();
    let mut image_entries = Vec::new();
    let mut basename_counts = BTreeMap::<String, usize>::new();
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| WikiFailure::state(format!("invalid MinerU zip entry: {error}")))?;
        let path = normalize_mineru_zip_path(file.name());
        if path.ends_with(".md") {
            markdown_entries.push(path);
        } else if is_mineru_image_path(&path) {
            if let Some(name) = file_name_str(&path) {
                *basename_counts.entry(name.to_owned()).or_default() += 1;
            }
            image_entries.push(path);
        }
    }
    let markdown_name = markdown_entries
        .iter()
        .find(|path| file_name_str(path).is_some_and(|name| name.eq_ignore_ascii_case("full.md")))
        .or_else(|| markdown_entries.first())
        .ok_or_else(|| WikiFailure::state("No Markdown file found in MinerU result zip"))?
        .clone();
    let mut markdown = String::new();
    archive
        .by_name(&markdown_name)
        .map_err(|error| WikiFailure::state(format!("MinerU markdown entry missing: {error}")))?
        .read_to_string(&mut markdown)
        .map_err(|error| WikiFailure::state(format!("MinerU markdown read failed: {error}")))?;
    let mut path_map = BTreeMap::new();
    let mut images = Vec::new();
    for image_path in image_entries {
        cancel_if_requested(&cancellation)?;
        let mut file = archive
            .by_name(&image_path)
            .map_err(|error| WikiFailure::state(format!("MinerU image entry missing: {error}")))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| WikiFailure::state(format!("MinerU image read failed: {error}")))?;
        let rel_path = mineru_asset_rel_path(source_slug, &image_path);
        path_map.insert(image_path.clone(), rel_path.clone());
        if let Some(name) = file_name_str(&image_path) {
            if basename_counts.get(name).copied().unwrap_or_default() == 1 {
                path_map.insert(name.to_owned(), rel_path.clone());
            }
        }
        images.push(WikiParsedImportImage {
            index: images.len() as u32 + 1,
            mime_type: mineru_image_mime_type(&rel_path).to_owned(),
            page: None,
            width: 0,
            height: 0,
            rel_path: Some(rel_path),
            data_base64: B64.encode(&bytes),
            sha256: sha256_hex(&bytes),
        });
    }
    Ok(MineruParseResult {
        markdown: rewrite_mineru_markdown_images(&markdown, &path_map),
        images,
    })
}

fn local_mineru_result(
    value: &serde_json::Value,
    source_slug: &str,
) -> Result<MineruParseResult, WikiFailure> {
    let entry = value
        .get("results")
        .and_then(serde_json::Value::as_object)
        .and_then(|results| results.values().next())
        .ok_or_else(|| WikiFailure::state("local MinerU returned an empty parsing result"))?;
    let mut markdown = entry
        .get("md_content")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| WikiFailure::state("local MinerU returned an empty parsing result"))?
        .to_owned();
    let mut path_map = BTreeMap::new();
    let mut images = Vec::new();
    if let Some(items) = entry.get("images").and_then(serde_json::Value::as_object) {
        for (raw_name, raw_data) in items {
            let Some(data_uri) = raw_data.as_str() else {
                continue;
            };
            let Some((mime_type, data_base64)) = parse_image_data_uri(data_uri) else {
                continue;
            };
            let Some(extension) = mineru_extension_for_mime_type(mime_type) else {
                continue;
            };
            let normalized_name = normalize_mineru_zip_path(raw_name);
            let source_name = file_name_str(&normalized_name)
                .unwrap_or(raw_name)
                .to_owned();
            let bytes = B64.decode(data_base64).unwrap_or_default();
            let rel_path = format!(
                "media/{source_slug}/mineru/images/image-{}.{}",
                images.len() + 1,
                safe_mineru_asset_segment(extension)
            );
            path_map.insert(raw_name.clone(), rel_path.clone());
            path_map.insert(normalized_name, rel_path.clone());
            path_map.insert(source_name, rel_path.clone());
            images.push(WikiParsedImportImage {
                index: images.len() as u32 + 1,
                mime_type: mime_type.to_owned(),
                page: None,
                width: 0,
                height: 0,
                rel_path: Some(rel_path),
                data_base64: data_base64.to_owned(),
                sha256: sha256_hex(&bytes),
            });
        }
    }
    if !path_map.is_empty() {
        markdown = rewrite_mineru_markdown_images(&markdown, &path_map);
    }
    Ok(MineruParseResult { markdown, images })
}

async fn local_mineru_health_version(
    client: &reqwest::Client,
    endpoint: &str,
    token: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<Option<String>, WikiFailure> {
    let request = mineru_auth(client.get(format!("{endpoint}/health")), token);
    let response = match cancel_on_token(cancellation, request.send()).await? {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    let value = match cancel_on_token(cancellation, response.json::<serde_json::Value>()).await? {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok(value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned))
}

fn mineru_source_url<'a>(
    input: &WikiStagedImportSource,
    private: &'a MineruPrivateConfig,
) -> Option<&'a str> {
    private
        .source_urls
        .get(&input.source_relative_path)
        .or_else(|| private.source_urls.get(&input.source_identity))
        .map(String::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
}

fn local_mineru_backend_for_version(backend: &str, version: Option<String>) -> String {
    if version.as_deref().is_some_and(|version| {
        version.trim().starts_with("3.0")
            || version.trim().starts_with("3.1")
            || version.trim().starts_with("3.2")
    }) {
        match backend {
            "vlm-engine" => "vlm-auto-engine".to_owned(),
            "hybrid-engine" => "hybrid-auto-engine".to_owned(),
            _ => backend.to_owned(),
        }
    } else {
        backend.to_owned()
    }
}

fn local_mineru_api_base(endpoint: &str) -> Result<String, WikiFailure> {
    let candidate = if endpoint.trim().is_empty() {
        "http://127.0.0.1:8000"
    } else {
        endpoint.trim()
    };
    let parsed = reqwest::Url::parse(candidate).map_err(|_| {
        WikiFailure::invalid_input(
            "mineruLocalEndpoint",
            "Local MinerU endpoint must be a valid HTTP(S) URL",
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(WikiFailure::invalid_input(
            "mineruLocalEndpoint",
            "Local MinerU endpoint must be an HTTP(S) URL without credentials",
        ));
    }
    Ok(candidate.trim_end_matches('/').to_owned())
}

fn mineru_auth(builder: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token.map(str::trim).filter(|token| !token.is_empty()) {
        Some(token) => builder.bearer_auth(token),
        None => builder,
    }
}

async fn mineru_send(
    cancellation: &CancellationToken,
    request: reqwest::RequestBuilder,
    label: &str,
) -> Result<reqwest::Response, WikiFailure> {
    let response = cancel_on_token(cancellation, request.send())
        .await?
        .map_err(|error| WikiFailure::state(format!("{label} failed: {error}")))?;
    if !response.status().is_success() {
        return Err(WikiFailure::state(format!(
            "{label} failed: HTTP {}",
            response.status()
        )));
    }
    Ok(response)
}

async fn mineru_json(
    cancellation: &CancellationToken,
    response: reqwest::Response,
    label: &str,
) -> Result<serde_json::Value, WikiFailure> {
    cancel_on_token(cancellation, response.json::<serde_json::Value>())
        .await?
        .map_err(|error| WikiFailure::state(format!("invalid {label} response: {error}")))
}

fn mineru_assert_success(value: &serde_json::Value) -> Result<(), WikiFailure> {
    match value.get("code") {
        Some(serde_json::Value::Number(code)) if code.as_i64() == Some(0) => Ok(()),
        Some(serde_json::Value::String(code)) if code == "0" => Ok(()),
        code => Err(WikiFailure::state(format!(
            "MinerU API error {}: {}",
            code.map(serde_json::Value::to_string)
                .unwrap_or_else(|| "unknown".to_owned()),
            value
                .get("msg")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown error")
        ))),
    }
}

async fn wait_mineru_poll(cancellation: &CancellationToken) -> Result<(), WikiFailure> {
    cancel_on_token(cancellation, tokio::time::sleep(MINERU_POLL_INTERVAL)).await
}

async fn cancel_on_token<T>(
    cancellation: &CancellationToken,
    future: impl Future<Output = T>,
) -> Result<T, WikiFailure> {
    tokio::select! {
        _ = cancellation.cancelled() => Err(WikiFailure::cancelled()),
        value = future => Ok(value),
    }
}

fn cancel_if_requested(cancellation: &CancellationToken) -> Result<(), WikiFailure> {
    if cancellation.is_cancelled() {
        Err(WikiFailure::cancelled())
    } else {
        Ok(())
    }
}

fn json_string(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_owned)
}

fn parse_image_data_uri(value: &str) -> Option<(&str, &str)> {
    let rest = value.strip_prefix("data:")?;
    let (mime_type, data) = rest.split_once(";base64,")?;
    Some((mime_type, data))
}

fn mineru_extension_for_mime_type(mime_type: &str) -> Option<&'static str> {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        "image/tiff" => Some("tiff"),
        _ => None,
    }
}

fn mineru_image_mime_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("tif" | "tiff") => "image/tiff",
        _ => "image/png",
    }
}

fn is_mineru_image_path(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "tif" | "tiff")
    )
}

fn mineru_asset_rel_path(source_slug: &str, zip_path: &str) -> String {
    let safe = normalize_mineru_zip_path(zip_path)
        .split('/')
        .map(safe_mineru_asset_segment)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    format!(
        "media/{source_slug}/mineru/{}",
        if safe.is_empty() { "image.png" } else { &safe }
    )
}

fn normalize_mineru_zip_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("./")
        .split('/')
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect::<Vec<_>>()
        .join("/")
}

fn safe_mineru_asset_segment(segment: &str) -> String {
    let decoded = decode_uri_component_lossy(segment);
    let mut out = decoded
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0'..='\u{1f}' | '/' | '\\' => '_',
            c => c,
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_owned();
    if out.is_empty() {
        out = "asset".to_owned();
    }
    if out.len() > 80 {
        let extension = Path::new(&out)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{extension}"))
            .unwrap_or_default();
        let keep = 80usize.saturating_sub(extension.len());
        out.truncate(keep);
        out.push_str(&extension);
    }
    out
}

fn rewrite_mineru_markdown_images(markdown: &str, path_map: &BTreeMap<String, String>) -> String {
    let markdown = convert_html_tables_to_markdown(markdown, path_map);
    let markdown = rewrite_mineru_html_images(&markdown, path_map);
    let mut output = String::with_capacity(markdown.len());
    let mut rest = markdown.as_str();
    while let Some(image_ref) = next_markdown_image(rest) {
        output.push_str(&rest[..image_ref.start]);
        if let Some(rel_path) = mineru_mapped_rel_path(image_ref.target, path_map) {
            let original = &rest[image_ref.start..image_ref.end];
            output.push_str(&rewrite_markdown_image_target(
                original,
                &image_ref,
                &encode_markdown_image_url(rel_path),
            ));
        } else {
            output.push_str(&rest[image_ref.start..image_ref.end]);
        }
        rest = &rest[image_ref.end..];
    }
    output.push_str(rest);
    output
}

fn mineru_mapped_rel_path<'a>(
    target: &str,
    path_map: &'a BTreeMap<String, String>,
) -> Option<&'a String> {
    if has_url_scheme(target) {
        return None;
    }
    let key = normalize_mineru_zip_path(&decode_uri_component_lossy(strip_image_target_suffix(
        target,
    )));
    path_map
        .get(&key)
        .or_else(|| file_name_str(&key).and_then(|name| path_map.get(name)))
}

fn rewrite_mineru_html_images(markdown: &str, path_map: &BTreeMap<String, String>) -> String {
    let mut output = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(start) = rest.find("<img") {
        output.push_str(&rest[..start]);
        let Some(end_offset) = rest[start..].find('>') else {
            output.push_str(&rest[start..]);
            return output;
        };
        let end = start + end_offset + 1;
        let tag = &rest[start..end];
        if let Some(src) = html_attr(tag, "src") {
            if let Some(rel_path) = mineru_mapped_rel_path(&src, path_map) {
                let alt = html_attr(tag, "alt").unwrap_or_default();
                let title = html_attr(tag, "title")
                    .filter(|title| !title.trim().is_empty())
                    .map(|title| format!(" \"{}\"", title.replace('"', "\\\"")))
                    .unwrap_or_default();
                output.push_str(&format!(
                    "![{}]({}{title})",
                    escape_markdown_alt(&alt),
                    encode_markdown_image_url(rel_path),
                ));
            } else {
                output.push_str(tag);
            }
        } else {
            output.push_str(tag);
        }
        rest = &rest[end..];
    }
    output.push_str(rest);
    output
}

fn convert_html_tables_to_markdown(markdown: &str, path_map: &BTreeMap<String, String>) -> String {
    let mut output = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(start) = rest.find("<table") {
        output.push_str(&rest[..start]);
        let Some(end_offset) = rest[start..].find("</table>") else {
            output.push_str(&rest[start..]);
            return output;
        };
        let end = start + end_offset + "</table>".len();
        output.push_str(&html_table_to_markdown(&rest[start..end], path_map));
        rest = &rest[end..];
    }
    output.push_str(rest);
    output
}

fn html_table_to_markdown(table: &str, path_map: &BTreeMap<String, String>) -> String {
    let mut rows = Vec::new();
    let mut rest = table;
    while let Some(row_start) = rest.find("<tr") {
        let Some(open_end) = rest[row_start..].find('>') else {
            break;
        };
        let content_start = row_start + open_end + 1;
        let Some(row_end_offset) = rest[content_start..].find("</tr>") else {
            break;
        };
        let row_end = content_start + row_end_offset;
        let cells = html_row_cells(&rest[content_start..row_end], path_map);
        if !cells.is_empty() {
            rows.push(cells);
        }
        rest = &rest[row_end + "</tr>".len()..];
    }
    if rows.is_empty() {
        return table.to_owned();
    }
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut output = String::new();
    output.push('\n');
    for (index, row) in rows.iter().enumerate() {
        output.push('|');
        for cell in padded_cells(row, columns) {
            output.push(' ');
            output.push_str(&cell.replace('|', "\\|"));
            output.push_str(" |");
        }
        output.push('\n');
        if index == 0 {
            output.push('|');
            for _ in 0..columns {
                output.push_str(" --- |");
            }
            output.push('\n');
        }
    }
    output.push('\n');
    output
}

fn html_row_cells(row: &str, path_map: &BTreeMap<String, String>) -> Vec<String> {
    let mut cells = Vec::new();
    let mut rest = row;
    loop {
        let td = rest.find("<td");
        let th = rest.find("<th");
        let (start, close) = match (td, th) {
            (Some(td), Some(th)) if td < th => (td, "</td>"),
            (Some(_), Some(th)) => (th, "</th>"),
            (Some(td), None) => (td, "</td>"),
            (None, Some(th)) => (th, "</th>"),
            (None, None) => break,
        };
        let Some(open_end) = rest[start..].find('>') else {
            break;
        };
        let content_start = start + open_end + 1;
        let Some(end_offset) = rest[content_start..].find(close) else {
            break;
        };
        let end = content_start + end_offset;
        cells.push(html_cell_text(&rest[content_start..end], path_map));
        rest = &rest[end + close.len()..];
    }
    cells
}

fn html_cell_text(cell: &str, path_map: &BTreeMap<String, String>) -> String {
    let with_images = rewrite_mineru_html_images(cell, path_map);
    let mut output = String::new();
    let mut in_tag = false;
    for c in with_images.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => output.push(c),
            _ => {}
        }
    }
    clean_caption(decode_html_entities(&output))
}

fn padded_cells(row: &[String], columns: usize) -> Vec<String> {
    let mut cells = row.to_vec();
    cells.resize(columns, String::new());
    cells
}

fn html_attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{name}=");
    let start = lower.find(&needle)? + needle.len();
    let quote = tag[start..].chars().next()?;
    if quote == '"' || quote == '\'' {
        let value_start = start + quote.len_utf8();
        let value_end = tag[value_start..].find(quote)? + value_start;
        Some(decode_html_entities(&tag[value_start..value_end]))
    } else {
        let value_end = tag[start..]
            .find(|c: char| c.is_whitespace() || c == '>')
            .map(|end| start + end)
            .unwrap_or(tag.len());
        Some(decode_html_entities(&tag[start..value_end]))
    }
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn encode_markdown_image_url(path: &str) -> String {
    path.split('/')
        .map(percent_encode_path_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_encode_path_segment(value: &str) -> String {
    let mut output = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            output.push(*byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn file_name_str(path: &str) -> Option<&str> {
    path.rsplit('/').next().filter(|name| !name.is_empty())
}

fn is_pdf_source(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

async fn commit_import_source(
    global: &WikiState,
    shared: &WikiShared,
    input: WikiParsedImportSource,
) -> Result<WikiImportSourceReceipt, WikiFailure> {
    let project_id = input.staged.project_id.clone();
    let source_relative_path = input.staged.source_relative_path.clone();
    let project_root = input.staged.project_root.clone();
    let cancellation = shared
        .source_task_cancellation(&project_id, &source_relative_path)
        .await;
    let result = commit_import_source_inner(global, shared, input, cancellation).await;
    if result.as_ref().err().is_some_and(WikiFailure::is_cancelled) {
        let _ = mark_source_task_cancelled(&project_root, &project_id, &source_relative_path);
    }
    shared
        .clear_source_task_cancellation(&project_id, &source_relative_path)
        .await;
    result
}

async fn commit_import_source_inner(
    global: &WikiState,
    shared: &WikiShared,
    input: WikiParsedImportSource,
    cancellation: CancellationToken,
) -> Result<WikiImportSourceReceipt, WikiFailure> {
    reject_cancelled_source_task(&input.staged, &cancellation)?;
    mark_source_task_running(
        &input.staged.project_root,
        &input.staged.project_id,
        &input.staged.source_relative_path,
        "commit",
        45,
    )?;
    let project = selected_project(global, Some(&input.staged.project_id))?;
    let root = project_root(project);
    let source_hash = source_content_hash(&input.text);
    let source_config = read_source_watch_config(root).unwrap_or_default();
    validate_ingest_model_config(&source_config)?;
    let output_language = configured_output_language(source_config.output_language());
    let generation_model_ref = source_config
        .generation_model_ref()
        .expect("generation model ref was validated")
        .to_owned();
    let caption_model_ref = source_config.caption_model_ref().map(str::to_owned);
    let mut images = write_import_images(&input.staged, &input.images)?;
    let (text, markdown_images) = extract_markdown_local_images(&input.staged, &input.text)?;
    images.extend(markdown_images);
    if source_config.caption_enabled() && !images.is_empty() && caption_model_ref.is_none() {
        return Err(WikiFailure::invalid_input(
            "captionModelRef",
            "Wiki image caption model is not configured",
        ));
    }
    if source_config.caption_enabled() && !images.is_empty() {
        reject_cancelled_source_task(&input.staged, &cancellation)?;
        mark_source_task_running(
            root,
            &input.staged.project_id,
            &input.staged.source_relative_path,
            "caption",
            55,
        )?;
        caption_import_images(
            shared.ingest_llm.clone(),
            root,
            &mut images,
            &text,
            source_config.caption_concurrency(),
            output_language,
            caption_model_ref.as_deref(),
            cancellation.clone(),
        )
        .await?;
    }
    let source_text = if source_config.caption_enabled() {
        apply_image_captions_to_source_text(&text, &images)
    } else {
        strip_markdown_image_refs(&text)
    };
    let content = import_source_markdown(
        &input.staged,
        &source_text,
        source_config
            .caption_enabled()
            .then_some(images.as_slice())
            .unwrap_or(&[]),
    );
    let path = resolve_project_path(root, &input.staged.page_relative_path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    std::fs::write(&path, content.as_bytes())
        .map_err(|error| WikiFailure::io(path_text(&path), error))?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    let revision = WikiRevision::for_bytes(
        content.as_bytes(),
        metadata.modified().map(system_time_ms).unwrap_or_default(),
    );
    if shared.ingest_llm.is_none() {
        if let Some(receipt) = cached_import_receipt(root, &input.staged, &source_hash)? {
            mark_source_task_done(
                root,
                &input.staged.project_id,
                &input.staged.source_relative_path,
            )?;
            return Ok(receipt);
        }
    }

    let mut generation_input = input.clone();
    generation_input.text = source_text;
    reject_cancelled_source_task(&input.staged, &cancellation)?;
    mark_source_task_running(
        root,
        &input.staged.project_id,
        &input.staged.source_relative_path,
        "generate",
        70,
    )?;
    let mut written_paths = vec![input.staged.page_relative_path.clone()];
    if let Some(generated_pages) = crate::ingest::generate_imported_pages(
        shared.ingest_llm.clone(),
        root,
        &generation_input,
        output_language,
        Some(generation_model_ref.as_str()),
        cancellation.clone(),
    )
    .await?
    {
        let checkpoint_path = generated_pages.checkpoint_path.clone();
        let generated = source_lifecycle::apply_generated_pages(
            root,
            &input.staged.project_id,
            WikiApplyGeneratedPagesInput {
                project_id: Some(input.staged.project_id.clone()),
                source_path: input.staged.source_relative_path.clone(),
                files: generated_pages.files,
                reviews: generated_pages.reviews,
            },
            Some(source_hash.clone()),
            shared.ingest_llm.clone(),
            Some(generation_model_ref.as_str()),
            Some(cancellation.clone()),
        )
        .await?;
        if let Some(path) = checkpoint_path.as_deref() {
            let _ = std::fs::remove_file(path);
        }
        written_paths.extend(
            generated
                .written_pages()
                .iter()
                .map(|receipt| receipt.relative_path().to_owned()),
        );
    } else {
        write_source_cache_entry(
            root,
            &input.staged.source_identity,
            SourceCacheEntry {
                hash: source_hash,
                timestamp: now_ms(),
                files_written: written_paths.clone(),
            },
        )?;
        mark_source_task_done(
            root,
            &input.staged.project_id,
            &input.staged.source_relative_path,
        )?;
    }

    let snapshot_paths = written_paths.iter().map(String::as_str).collect::<Vec<_>>();
    refresh_file_snapshot(root, &snapshot_paths)?;
    embed_written_paths(shared, global, &input.staged.project_id, &written_paths).await;
    Ok(WikiImportSourceReceipt::new(
        input.staged.source_relative_path,
        input.staged.page_relative_path,
        revision,
    ))
}

fn reject_cancelled_source_task(
    staged: &WikiStagedImportSource,
    cancellation: &CancellationToken,
) -> Result<(), WikiFailure> {
    if source_task_paused(
        &staged.project_root,
        &staged.project_id,
        &staged.source_relative_path,
    )? {
        return Err(WikiFailure::cancelled());
    }
    if cancellation.is_cancelled()
        || source_task_cancel_requested(
            &staged.project_root,
            &staged.project_id,
            &staged.source_relative_path,
        )?
    {
        mark_source_task_cancelled(
            &staged.project_root,
            &staged.project_id,
            &staged.source_relative_path,
        )?;
        return Err(WikiFailure::cancelled());
    }
    Ok(())
}

fn cached_import_receipt(
    root: &Path,
    staged: &WikiStagedImportSource,
    source_hash: &str,
) -> Result<Option<WikiImportSourceReceipt>, WikiFailure> {
    let cache = read_source_cache(root)?;
    let Some(entry) = cache.entries.get(&staged.source_identity) else {
        return Ok(None);
    };
    if entry.hash != source_hash
        || entry
            .files_written
            .iter()
            .any(|relative_path| !root.join(relative_path).is_file())
    {
        return Ok(None);
    }
    let path = resolve_project_path(root, &staged.page_relative_path)?;
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    Ok(Some(WikiImportSourceReceipt::new(
        staged.source_relative_path.clone(),
        staged.page_relative_path.clone(),
        WikiRevision::for_bytes(
            &bytes,
            metadata.modified().map(system_time_ms).unwrap_or_default(),
        ),
    )))
}

async fn extract_import_images(
    staged: &WikiStagedImportSource,
    cancellation: CancellationToken,
) -> Result<Vec<WikiParsedImportImage>, WikiFailure> {
    let source_path = staged.source_path.clone();
    let task = tokio::task::spawn_blocking(move || {
        let path = path_text(&source_path);
        let images = match extension(&source_path).as_str() {
            "pdf" => crate::preprocess::extract_pdf_images(
                &path,
                &crate::preprocess::ExtractOptions::default(),
            ),
            ext if is_zip_office_ext(ext) => crate::preprocess::extract_office_images(
                &path,
                &crate::preprocess::ExtractOptions::default(),
            ),
            _ => Ok(Vec::new()),
        }?;
        Ok::<Vec<WikiParsedImportImage>, String>(
            images
                .into_iter()
                .map(|image| WikiParsedImportImage {
                    index: image.index,
                    mime_type: image.mime_type,
                    page: image.page,
                    width: image.width,
                    height: image.height,
                    rel_path: None,
                    data_base64: image.data_base64,
                    sha256: image.sha256,
                })
                .collect(),
        )
    });
    cancel_on_token(&cancellation, task)
        .await?
        .map_err(|error| {
            WikiFailure::state(format!("source image extraction task failed: {error}"))
        })?
        .map_err(WikiFailure::state)
}

fn import_source_markdown(
    staged: &WikiStagedImportSource,
    text: &str,
    images: &[ImportedImage],
) -> String {
    let title = source_title(&staged.source_identity);
    let title_json = serde_json::to_string(&title).unwrap_or_else(|_| "\"Source\"".to_owned());
    let source_json =
        serde_json::to_string(&staged.source_identity).unwrap_or_else(|_| "\"source\"".to_owned());
    let mut output = format!(
        "---\ntitle: {title_json}\nsources:\n  - {source_json}\n---\n\n# {title}\n\n{}",
        text.trim()
    );
    if !images.is_empty() {
        output.push_str("\n\n<!-- llm-wiki:embedded-images -->\n\n## Embedded Images\n\n");
        for image in images {
            let alt = image.caption.as_deref().unwrap_or("Image");
            output.push_str(&format!(
                "![{}]({})\n",
                escape_markdown_alt(alt),
                source_page_image_path(&image.rel_path),
            ));
            if let Some(caption) = image.caption.as_deref() {
                output.push_str(&format!("\n{caption}\n"));
            }
            output.push('\n');
        }
        output.push_str("<!-- /llm-wiki:embedded-images -->");
    }
    output
}

async fn delete_source(
    global: &WikiState,
    input: WikiDeleteSourceInput,
) -> Result<WikiDeleteSourceReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    source_lifecycle::delete_source(project_root(project), project.project_id(), input).await
}

fn migrate_source_path(
    global: &WikiState,
    project_id: &str,
    old_source_relative_path: &str,
    new_source_relative_path: &str,
) -> Result<WikiSourceMoveReceipt, WikiFailure> {
    let project = selected_project(global, Some(project_id))?;
    source_lifecycle::migrate_source_path(
        project_root(project),
        project.project_id(),
        old_source_relative_path,
        new_source_relative_path,
    )
}

async fn cleanup_deleted_wiki_pages_for_project(
    global: &WikiState,
    project_id: &str,
    paths: &[String],
) -> Result<(), WikiFailure> {
    let project = selected_project(global, Some(project_id))?;
    cleanup_deleted_wiki_pages(project_root(project), paths).await
}

async fn apply_generated_pages(
    global: &WikiState,
    shared: &WikiShared,
    input: WikiApplyGeneratedPagesInput,
) -> Result<WikiApplyGeneratedPagesReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let receipt = source_lifecycle::apply_generated_pages(
        project_root(project),
        project.project_id(),
        input,
        None,
        None,
        None,
        None,
    )
    .await?;
    embed_written_pages(
        shared,
        global,
        project.project_id(),
        receipt.written_pages(),
    )
    .await;
    Ok(receipt)
}

fn reviews(
    global: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiReviewsReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    Ok(super::review_lifecycle::reviews(project_root(project)))
}

fn resolve_review(
    global: &WikiState,
    input: WikiReviewResolveInput,
) -> Result<WikiReviewsReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    super::review_lifecycle::resolve_review(project_root(project), input)
}

fn dismiss_review(
    global: &WikiState,
    input: WikiReviewDismissInput,
) -> Result<WikiReviewsReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    super::review_lifecycle::dismiss_review(project_root(project), input)
}

fn clear_resolved_reviews(
    global: &WikiState,
    input: WikiReviewClearResolvedInput,
) -> Result<WikiReviewsReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    super::review_lifecycle::clear_resolved_reviews(project_root(project), input)
}

fn source_tasks(
    global: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiSourceTasksReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    source_lifecycle::source_tasks(
        project_root(project),
        WikiProjectSelector {
            project_id: Some(project.project_id().to_owned()),
        },
    )
}

fn mark_source_task_failed_for_project(
    global: &WikiState,
    project_id: &str,
    source_relative_path: &str,
    error: String,
) -> Result<(), WikiFailure> {
    let project = selected_project(global, Some(project_id))?;
    source_lifecycle::mark_source_task_failed(
        project_root(project),
        project.project_id(),
        source_relative_path,
        error,
    )
}

async fn cancel_source_task(
    shared: &WikiShared,
    global: &WikiState,
    input: WikiCancelSourceTaskInput,
) -> Result<WikiSourceTasksReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let source_relative_path =
        source_lifecycle::source_relative_path(project_root(project), &input.source_path)?;
    shared
        .cancel_source_task_token(project.project_id(), &source_relative_path)
        .await;
    request_source_task_cancel(
        project_root(project),
        project.project_id(),
        &source_relative_path,
    )
}

fn retry_source_task(
    global: &WikiState,
    input: WikiSourceTaskActionInput,
) -> Result<crate::application::commands::WikiSourceTaskRunPlan, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    source_lifecycle::retry_source_task(
        project_root(project),
        project.project_id(),
        &input.source_path,
    )
}

async fn pause_source_task(
    shared: &WikiShared,
    global: &WikiState,
    input: WikiSourceTaskActionInput,
) -> Result<WikiSourceTasksReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let source_relative_path =
        source_lifecycle::source_relative_path(project_root(project), &input.source_path)?;
    shared
        .cancel_source_task_token(project.project_id(), &source_relative_path)
        .await;
    source_lifecycle::pause_source_task(
        project_root(project),
        project.project_id(),
        &input.source_path,
    )
}

fn resume_source_task(
    global: &WikiState,
    input: WikiSourceTaskActionInput,
) -> Result<crate::application::commands::WikiSourceTaskRunPlan, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    source_lifecycle::resume_source_task(
        project_root(project),
        project.project_id(),
        &input.source_path,
    )
}

fn reorder_source_task(
    global: &WikiState,
    input: WikiReorderSourceTaskInput,
) -> Result<WikiSourceTasksReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    source_lifecycle::reorder_source_task(
        project_root(project),
        project.project_id(),
        &input.source_path,
        input.before_source_path.as_deref(),
        input.after_source_path.as_deref(),
    )
}

fn search(global: &WikiState, input: WikiSearchInput) -> Result<WikiSearchReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    keyword_search(project_root(project), &input.query, input.limit.max(1))
}

fn graph(
    global: &WikiState,
    input: WikiProjectSelector,
) -> Result<crate::domain::WikiGraphReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    build_graph(project_root(project))
}

fn rescan(
    global: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiStatusReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    write_file_snapshot(project_root(project))?;
    status(global)
}

async fn embed_written_pages(
    shared: &WikiShared,
    global: &WikiState,
    project_id: &str,
    written_pages: &[WikiWriteReceipt],
) {
    let paths = written_pages
        .iter()
        .map(|receipt| receipt.relative_path().to_owned())
        .collect::<Vec<_>>();
    embed_written_paths(shared, global, project_id, &paths).await;
}

async fn embed_written_paths(
    shared: &WikiShared,
    global: &WikiState,
    project_id: &str,
    paths: &[String],
) {
    for path in paths.iter().filter(|path| should_auto_embed_page(path)) {
        let _ = embed_page(
            shared,
            global,
            WikiPathSelector {
                project_id: Some(project_id.to_owned()),
                relative_path: path.clone(),
            },
        )
        .await;
    }
}

fn should_auto_embed_page(path: &str) -> bool {
    path.starts_with("wiki/")
        && path.ends_with(".md")
        && !matches!(path, "wiki/index.md" | "wiki/log.md" | "wiki/overview.md")
}

async fn embed_page(
    shared: &WikiShared,
    global: &WikiState,
    input: WikiPathSelector,
) -> Result<(), WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let read = read_file(
        global,
        WikiReadInput {
            project_id: Some(project.project_id().to_owned()),
            relative_path: input.relative_path.clone(),
            limit: 0,
        },
    )?;
    let chunks = chunk_markdown(&input.relative_path, read.content(), 1200);
    shared
        .vector_index
        .embed_page(
            project_root(project),
            &input.relative_path,
            read.revision(),
            &chunks,
        )
        .await
        .map_err(WikiFailure::from)
}

async fn retrieve_context(
    shared: &WikiShared,
    global: &WikiState,
    input: WikiRetrieveContextInput,
) -> Result<WikiSearchReceipt, WikiFailure> {
    let project = selected_project(global, input.project_id.as_deref())?;
    let fallback = keyword_search(project_root(project), &input.query, input.limit.max(1))?;
    shared
        .vector_index
        .retrieve_context(project_root(project), &input, fallback)
        .await
        .map_err(WikiFailure::from)
}

async fn caption_import_images(
    llm: Option<Arc<dyn WikiIngestLlm>>,
    root: &Path,
    images: &mut [ImportedImage],
    source_text: &str,
    concurrency: u8,
    output_language: Option<&str>,
    caption_model_ref: Option<&str>,
    cancellation: CancellationToken,
) -> Result<(), WikiFailure> {
    let Some(llm) = llm else {
        return Ok(());
    };
    let cache = read_image_caption_cache(root)?;
    let requests = images
        .iter()
        .enumerate()
        .filter(|(_, image)| image.caption.is_none())
        .map(|(index, image)| {
            (
                index,
                image.sha256.clone(),
                image.mime_type.clone(),
                image.data_base64.clone(),
                image_caption_prompt(output_language, source_text, image),
                caption_model_ref.map(str::to_owned),
            )
        })
        .collect::<Vec<_>>();
    let captions = stream::iter(requests)
        .map(
            |(index, sha256, mime_type, data_base64, prompt, caption_model_ref)| {
                let llm = llm.clone();
                let cancellation = cancellation.clone();
                let cached = cache.caption(&sha256, output_language).map(str::to_owned);
                async move {
                    cancel_if_requested(&cancellation)?;
                    if let Some(caption) = cached {
                        return Ok::<_, WikiFailure>((index, sha256, Some(caption)));
                    }
                    let caption = match llm
                        .caption_image_cancellable(
                            WikiIngestImageCaptionRequest {
                                model_ref: caption_model_ref,
                                prompt,
                                mime_type,
                                data_base64,
                                options: WikiIngestLlmOptions {
                                    max_output_tokens: Some(240),
                                    temperature: Some(0.1),
                                },
                            },
                            cancellation.clone(),
                        )
                        .await
                    {
                        Ok(response) => response.caption,
                        Err(error) if error.is_cancelled() => return Err(error),
                        Err(_) => None,
                    };
                    Ok((index, sha256, caption))
                }
            },
        )
        .buffer_unordered(concurrency.max(1) as usize)
        .collect::<Vec<_>>()
        .await;
    let mut cache = cache;
    for result in captions {
        let (index, sha256, caption) = result?;
        let Some(caption) = caption
            .map(clean_caption)
            .filter(|caption| !caption.is_empty())
        else {
            continue;
        };
        if let Some(image) = images.get_mut(index) {
            image.caption = Some(caption.clone());
        }
        cache.insert(sha256, output_language, caption);
    }
    if let Err(error) = write_image_caption_cache(root, &cache) {
        eprintln!("[wiki] image caption cache write failed: {error:?}");
    }
    Ok(())
}

fn image_caption_prompt(
    output_language: Option<&str>,
    source_text: &str,
    image: &ImportedImage,
) -> String {
    let language = output_language.unwrap_or("the source document language");
    let context = image_context_window(source_text, image);
    format!(
        "Describe this image for a knowledge-base source summary in {language}. Use the surrounding source context when it helps, but describe only what is visible in the image. Preserve any visible text verbatim. For charts, name axes, legends, and apparent values. For diagrams, describe structure and relationships. Do not speculate. Answer in 2-4 concise sentences.\n\nSurrounding source context:\n{context}"
    )
}

fn image_context_window(source_text: &str, image: &ImportedImage) -> String {
    let mut rest = source_text;
    let mut offset = 0;
    while let Some(image_ref) = next_markdown_image(rest) {
        if markdown_image_matches(image_ref.target, image) {
            return caption_context_around(
                source_text,
                offset + image_ref.start,
                offset + image_ref.end,
            );
        }
        offset += image_ref.end;
        rest = &rest[image_ref.end..];
    }
    clean_caption(source_text.chars().take(300).collect())
}

fn caption_context_around(source_text: &str, start: usize, end: usize) -> String {
    let before = source_text[..start]
        .chars()
        .rev()
        .take(150)
        .collect::<Vec<_>>();
    let before = before.into_iter().rev().collect::<String>();
    let after = source_text[end..].chars().take(150).collect::<String>();
    clean_caption(format!("{before}{after}"))
}

fn apply_image_captions_to_source_text(text: &str, images: &[ImportedImage]) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(image_ref) = next_markdown_image(rest) {
        output.push_str(&rest[..image_ref.start]);
        let image = images
            .iter()
            .find(|image| markdown_image_matches(image_ref.target, image));
        if let Some((image, caption)) =
            image.and_then(|image| Some((image, image.caption.as_deref()?)))
        {
            if image_ref.wikilink {
                output.push_str(&format!(
                    "![{}]({})",
                    escape_markdown_alt(caption),
                    source_page_image_path(&image.rel_path)
                ));
            } else {
                let original = &rest[image_ref.start..image_ref.end];
                output.push_str(&rewrite_inline_markdown_image_alt(
                    original, image_ref, caption, image,
                ));
            }
        } else {
            output.push_str(&rest[image_ref.start..image_ref.end]);
        }
        rest = &rest[image_ref.end..];
    }
    output.push_str(rest);
    output
}

fn clean_caption(value: String) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn read_image_caption_cache(root: &Path) -> Result<ImageCaptionCache, WikiFailure> {
    ImageCaptionCache::read(root.join(IMAGE_CAPTION_CACHE_FILE))
}

fn write_image_caption_cache(root: &Path, cache: &ImageCaptionCache) -> Result<(), WikiFailure> {
    write_json(root.join(IMAGE_CAPTION_CACHE_FILE), cache)
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageCaptionCache {
    captions: BTreeMap<String, BTreeMap<String, String>>,
}

impl ImageCaptionCache {
    fn read(path: PathBuf) -> Result<Self, WikiFailure> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes =
            std::fs::read(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| WikiFailure::state(error.to_string()))?;
        if value.get("captions").is_some() {
            return serde_json::from_value(value)
                .map_err(|error| WikiFailure::state(error.to_string()));
        }
        let mut cache = Self::default();
        if let Some(flat) = value.as_object() {
            for (key, entry) in flat {
                let key_hash = flat_cache_image_hash(key);
                let sha256 = entry
                    .get("imageHash")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(key_hash);
                let decoded_language = flat_cache_language_key(key);
                let output_language = entry
                    .get("outputLanguage")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .or(decoded_language);
                let caption = entry
                    .get("caption")
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| entry.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                if let Some(caption) = caption {
                    cache.insert(
                        sha256.to_owned(),
                        output_language.as_deref(),
                        caption.to_owned(),
                    );
                }
            }
        }
        Ok(cache)
    }

    fn caption(&self, sha256: &str, output_language: Option<&str>) -> Option<&str> {
        self.captions
            .get(sha256)?
            .get(caption_language_key(output_language))
            .or_else(|| self.captions.get(sha256)?.get("auto"))
            .map(String::as_str)
    }

    fn insert(&mut self, sha256: String, output_language: Option<&str>, caption: String) {
        self.captions
            .entry(sha256)
            .or_default()
            .insert(caption_language_key(output_language).to_owned(), caption);
    }
}

impl<'de> Deserialize<'de> for ImageCaptionCache {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RustCache {
            captions: BTreeMap<String, BTreeMap<String, String>>,
        }
        Ok(Self {
            captions: RustCache::deserialize(deserializer)?.captions,
        })
    }
}

fn caption_language_key(output_language: Option<&str>) -> &str {
    output_language.unwrap_or("auto")
}

fn flat_cache_image_hash(key: &str) -> &str {
    key.split_once("::language:")
        .map(|(sha256, _)| sha256)
        .unwrap_or(key)
}

fn flat_cache_language_key(key: &str) -> Option<String> {
    key.split_once("::language:").and_then(|(_, language)| {
        let language = decode_uri_component_lossy(language.trim());
        (!language.is_empty()).then_some(language)
    })
}

fn write_import_images(
    staged: &WikiStagedImportSource,
    images: &[WikiParsedImportImage],
) -> Result<Vec<ImportedImage>, WikiFailure> {
    let media_dir = staged
        .project_root
        .join(WIKI_MEDIA_DIR)
        .join(&staged.import_id);
    match std::fs::remove_dir_all(&media_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(WikiFailure::io(path_text(&media_dir), error)),
    }
    if images.is_empty() {
        return Ok(Vec::new());
    }
    std::fs::create_dir_all(&media_dir)
        .map_err(|error| WikiFailure::io(path_text(&media_dir), error))?;
    let wiki_root = staged.project_root.join("wiki");
    images
        .iter()
        .map(|image| {
            let bytes = B64
                .decode(&image.data_base64)
                .map_err(|error| WikiFailure::state(format!("invalid image data: {error}")))?;
            let (path, rel_path) = match image.rel_path.as_deref() {
                Some(rel_path) => {
                    let rel_path = normalize_relative_path(Path::new(rel_path));
                    (wiki_root.join(&rel_path), rel_path)
                }
                None => {
                    let file_name = format!("img-{}.{}", image.index, image_ext(&image.mime_type));
                    let path = media_dir.join(file_name);
                    let rel_path = path
                        .strip_prefix(&wiki_root)
                        .map(normalize_relative_path)
                        .unwrap_or_else(|_| path_text(&path));
                    (path, rel_path)
                }
            };
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| WikiFailure::io(path_text(parent), error))?;
            }
            std::fs::write(&path, bytes)
                .map_err(|error| WikiFailure::io(path_text(&path), error))?;
            Ok(ImportedImage {
                index: image.index,
                mime_type: image.mime_type.clone(),
                page: image.page,
                width: image.width,
                height: image.height,
                rel_path,
                sha256: image.sha256.clone(),
                data_base64: image.data_base64.clone(),
                caption: None,
            })
        })
        .collect()
}

fn recover_imported_markdown_images(
    staged: &WikiStagedImportSource,
    markdown: &str,
) -> Result<Option<Vec<WikiParsedImportImage>>, WikiFailure> {
    let mut images = Vec::new();
    let mut seen = BTreeSet::new();
    let wiki_root = staged.project_root.join("wiki");
    let mut rest = markdown;
    while let Some(image_ref) = next_markdown_image(rest) {
        let target = strip_image_target_suffix(image_ref.target);
        let target = decode_uri_component_lossy(target);
        let target = target.strip_prefix("../").unwrap_or(&target);
        let normalized = normalize_relative_path(Path::new(target));
        if !normalized.starts_with(&format!("media/{}/mineru/", staged.import_id)) {
            rest = &rest[image_ref.end..];
            continue;
        }
        if !seen.insert(normalized.clone()) {
            rest = &rest[image_ref.end..];
            continue;
        }
        let path = wiki_root.join(&normalized);
        if !path.is_file() || !is_supported_image_path(&path) {
            rest = &rest[image_ref.end..];
            continue;
        }
        let bytes =
            std::fs::read(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
        let (width, height) = image::load_from_memory(&bytes)
            .map(|image| (image.width(), image.height()))
            .unwrap_or((0, 0));
        images.push(WikiParsedImportImage {
            index: images.len() as u32 + 1,
            mime_type: image_mime_for_path(&path).to_owned(),
            page: None,
            width,
            height,
            rel_path: Some(normalized),
            data_base64: B64.encode(&bytes),
            sha256: sha256_hex(&bytes),
        });
        rest = &rest[image_ref.end..];
    }
    Ok((!images.is_empty()).then_some(images))
}

fn unique_import_target(raw_sources: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let candidate = raw_sources.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let file = Path::new(file_name);
    let stem = file
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("source");
    let extension = file.extension().and_then(|extension| extension.to_str());
    for index in 0.. {
        let suffix = if index == 0 {
            now_ms().to_string()
        } else {
            format!("{}-{index}", now_ms())
        };
        let name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}-{suffix}.{extension}"),
            _ => format!("{stem}-{suffix}"),
        };
        let target = raw_sources.join(name);
        if !target.exists() {
            return target;
        }
    }
    unreachable!()
}

fn configured_output_language(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed != "auto").then_some(trimmed)
}

fn source_title(source_relative_path: &str) -> String {
    Path::new(source_relative_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("Source")
        .to_owned()
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_zip_office_ext(extension: &str) -> bool {
    matches!(
        extension,
        "docx"
            | "docm"
            | "pptx"
            | "pptm"
            | "ppsx"
            | "ppsm"
            | "xlsx"
            | "xlsm"
            | "xlsb"
            | "odt"
            | "ods"
            | "odp"
    )
}

fn extract_markdown_local_images(
    staged: &WikiStagedImportSource,
    text: &str,
) -> Result<(String, Vec<ImportedImage>), WikiFailure> {
    if !is_markdown_source(&staged.source_path) {
        return Ok((text.to_owned(), Vec::new()));
    }
    let Some(source_dir) = staged.source_path.parent() else {
        return Ok((text.to_owned(), Vec::new()));
    };
    let media_dir = staged
        .project_root
        .join(WIKI_MEDIA_DIR)
        .join(&staged.import_id);
    std::fs::create_dir_all(&media_dir)
        .map_err(|error| WikiFailure::io(path_text(&media_dir), error))?;
    let wiki_root = staged.project_root.join("wiki");
    let mut output = String::with_capacity(text.len());
    let mut images = Vec::new();
    let mut copied = BTreeMap::new();
    let mut rest = text;
    while let Some(image_ref) = next_markdown_image(rest) {
        output.push_str(&rest[..image_ref.start]);
        if let Some((rel_path, image)) = copy_markdown_image(
            source_dir,
            &media_dir,
            &wiki_root,
            image_ref.target,
            images.len() + 1,
            &mut copied,
        )? {
            let source_page_path = source_page_image_path(&rel_path);
            if image_ref.wikilink {
                output.push_str(&format!("![]({source_page_path})"));
            } else {
                output.push_str(&rewrite_markdown_image_target(
                    &rest[image_ref.start..image_ref.end],
                    &image_ref,
                    &source_page_path,
                ));
            }
            if let Some(image) = image {
                images.push(image);
            }
        } else {
            output.push_str(&rest[image_ref.start..image_ref.end]);
        }
        rest = &rest[image_ref.end..];
    }
    output.push_str(rest);
    Ok((output, images))
}

fn strip_markdown_image_refs(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(image_ref) = next_markdown_image(rest) {
        output.push_str(&rest[..image_ref.start]);
        rest = &rest[image_ref.end..];
    }
    output.push_str(rest);
    output
}

fn next_markdown_image(text: &str) -> Option<MarkdownImageRef<'_>> {
    let wikilink_start = text.find("![[");
    let inline_start = text.find("![");
    let start = match (wikilink_start, inline_start) {
        (Some(wiki), Some(inline)) => wiki.min(inline),
        (Some(wiki), None) => wiki,
        (None, Some(inline)) => inline,
        (None, None) => return None,
    };
    if text[start..].starts_with("![[") {
        let target_start = start + 3;
        let target_end = text[target_start..].find("]]")? + target_start;
        let target = text[target_start..target_end].trim();
        let target = target
            .split_once('|')
            .map(|(target, _)| target)
            .unwrap_or(target)
            .trim();
        return Some(MarkdownImageRef {
            start,
            end: target_end + 2,
            target,
            alt: "",
            title: None,
            target_start,
            target_end,
            wikilink: true,
        });
    }
    let alt_start = start + 2;
    let alt_end = text[alt_start..].find(']')? + alt_start;
    if !text[alt_end..].starts_with("](") {
        return None;
    }
    let target_start = alt_end + 2;
    let target_end = find_markdown_image_target_end(text, target_start)?;
    let raw_target = text[target_start..target_end].trim();
    let (target, title) = split_markdown_image_target(raw_target);
    Some(MarkdownImageRef {
        start,
        end: target_end + 1,
        target,
        alt: &text[alt_start..alt_end],
        title,
        target_start,
        target_end,
        wikilink: false,
    })
}

fn find_markdown_image_target_end(text: &str, start: usize) -> Option<usize> {
    let mut escaped = false;
    let mut parens = 0usize;
    for (offset, c) in text[start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '(' => parens += 1,
            ')' if parens == 0 => return Some(start + offset),
            ')' => parens -= 1,
            _ => {}
        }
    }
    None
}

fn split_markdown_image_target(raw: &str) -> (&str, Option<&str>) {
    let raw = raw.trim();
    if raw.starts_with('<') {
        if let Some(end) = raw.find('>') {
            return (&raw[1..end], None);
        }
    }
    let Some(quote_start) = raw.find(|c| c == '"' || c == '\'') else {
        return (raw, None);
    };
    let quote = raw[quote_start..].chars().next().unwrap_or('"');
    let target = raw[..quote_start].trim();
    let title_start = quote_start + quote.len_utf8();
    let title = raw[title_start..]
        .find(quote)
        .map(|end| &raw[title_start..title_start + end]);
    (target, title)
}

#[derive(Clone, Copy)]
struct MarkdownImageRef<'a> {
    start: usize,
    end: usize,
    target: &'a str,
    alt: &'a str,
    title: Option<&'a str>,
    target_start: usize,
    target_end: usize,
    wikilink: bool,
}

fn copy_markdown_image(
    source_dir: &Path,
    media_dir: &Path,
    wiki_root: &Path,
    target: &str,
    index: usize,
    copied: &mut BTreeMap<String, String>,
) -> Result<Option<(String, Option<ImportedImage>)>, WikiFailure> {
    let Some(clean_target) = clean_local_image_target(target) else {
        return Ok(None);
    };
    let source = Path::new(&clean_target);
    let source = if source.is_absolute() {
        source.to_path_buf()
    } else {
        source_dir.join(source)
    };
    if !source.is_file() || !is_supported_image_path(&source) {
        return Ok(None);
    }
    let source_key = normalize_relative_path(&source);
    if let Some(rel_path) = copied.get(&source_key) {
        return Ok(Some((rel_path.clone(), None)));
    }
    let bytes =
        std::fs::read(&source).map_err(|error| WikiFailure::io(path_text(&source), error))?;
    let Some(file_name) = source.file_name().and_then(|name| name.to_str()) else {
        return Ok(None);
    };
    let output_name = format!("{index:03}-{}", safe_mineru_asset_segment(file_name));
    let path = media_dir.join(output_name);
    std::fs::write(&path, &bytes).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    let rel_path = path
        .strip_prefix(wiki_root)
        .map(normalize_relative_path)
        .unwrap_or_else(|_| path_text(&path));
    copied.insert(source_key, rel_path.clone());
    let (width, height) = image::load_from_memory(&bytes)
        .map(|image| (image.width(), image.height()))
        .unwrap_or((0, 0));
    Ok(Some((
        rel_path.clone(),
        Some(ImportedImage {
            index: index as u32,
            mime_type: image_mime_for_path(&source).to_owned(),
            page: None,
            width,
            height,
            rel_path,
            sha256: sha256_hex(&bytes),
            data_base64: B64.encode(bytes),
            caption: None,
        }),
    )))
}

fn clean_local_image_target(target: &str) -> Option<String> {
    let target = decode_uri_component_lossy(target.trim());
    let target = strip_image_target_suffix(&target);
    if target.is_empty() || has_url_scheme(target) || target.starts_with('#') {
        return None;
    }
    Some(target.to_owned())
}

fn strip_image_target_suffix(target: &str) -> &str {
    let target = target
        .split_once('#')
        .map(|(target, _)| target)
        .unwrap_or(target);
    let target = target
        .split_once('|')
        .map(|(target, _)| target)
        .unwrap_or(target);
    target
        .split_once(" \"")
        .map(|(target, _)| target)
        .unwrap_or(target)
        .trim()
}

fn decode_uri_component_lossy(value: &str) -> String {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                output.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).unwrap_or_else(|_| value.to_owned())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn is_markdown_source(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "md" | "mdx"))
}

fn has_url_scheme(value: &str) -> bool {
    value.split_once(':').is_some_and(|(scheme, _)| {
        !(scheme.len() == 1 && scheme.as_bytes()[0].is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    })
}

fn is_supported_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "tif" | "tiff"
            )
        })
}

fn markdown_image_matches(target: &str, image: &ImportedImage) -> bool {
    let clean = clean_local_image_target(target).unwrap_or_else(|| target.to_owned());
    let normalized = normalize_relative_path(Path::new(&clean));
    normalized == image.rel_path
        || normalized == source_page_image_path(&image.rel_path)
        || file_name_str(&normalized).is_some_and(|name| image.rel_path.ends_with(name))
}

fn rewrite_inline_markdown_image_alt(
    original: &str,
    image_ref: MarkdownImageRef<'_>,
    caption: &str,
    image: &ImportedImage,
) -> String {
    let target = source_page_image_path(&image.rel_path);
    let title = image_ref
        .title
        .filter(|title| !title.trim().is_empty())
        .map(|title| format!(" \"{}\"", title.replace('"', "\\\"")))
        .unwrap_or_default();
    let rewritten = format!("![{}]({target}{title})", escape_markdown_alt(caption));
    if image_ref.target_start >= image_ref.start && image_ref.target_end <= image_ref.end {
        rewritten
    } else {
        original.to_owned()
    }
}

fn rewrite_markdown_image_target(
    original: &str,
    image_ref: &MarkdownImageRef<'_>,
    target: &str,
) -> String {
    if image_ref.wikilink {
        return format!("![{}]({target})", escape_markdown_alt(image_ref.alt));
    }
    let title = image_ref
        .title
        .filter(|title| !title.trim().is_empty())
        .map(|title| format!(" \"{}\"", title.replace('"', "\\\"")))
        .unwrap_or_default();
    let rewritten = format!("![{}]({target}{title})", escape_markdown_alt(image_ref.alt));
    if rewritten.is_empty() {
        original.to_owned()
    } else {
        rewritten
    }
}

fn escape_markdown_alt(value: &str) -> String {
    clean_caption(value.to_owned()).replace(']', "\\]")
}

fn source_page_image_path(rel_path: &str) -> String {
    if let Some(path) = rel_path.strip_prefix("media/") {
        format!("../media/{path}")
    } else {
        rel_path.to_owned()
    }
}

fn image_mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("tif" | "tiff") => "image/tiff",
        _ => "image/png",
    }
}

fn image_ext(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/tiff" => "tiff",
        _ => "png",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ImportedImage {
    index: u32,
    mime_type: String,
    page: Option<u32>,
    width: u32,
    height: u32,
    rel_path: String,
    sha256: String,
    data_base64: String,
    caption: Option<String>,
}

fn upsert_project(
    global: &mut WikiState,
    root: &Path,
    title: Option<String>,
) -> Result<WikiProjectsReceipt, WikiFailure> {
    let now = now_ms();
    let project_id = project_id_for_root(root);
    let created_at_ms = global
        .registry
        .find(&project_id)
        .map(WikiProjectRecord::created_at_ms)
        .unwrap_or(now);
    let record = WikiProjectRecord::new(
        project_id.clone(),
        title.unwrap_or_else(|| title_for_root(root)),
        path_text(root),
        created_at_ms,
        now,
    );
    global.registry.upsert(record);
    global.current_project_id = Some(project_id);
    save_state(global)?;
    projects(global)
}

fn selected_project<'a>(
    global: &'a WikiState,
    project_id: Option<&str>,
) -> Result<&'a WikiProjectRecord, WikiFailure> {
    match project_id.or(global.current_project_id.as_deref()) {
        Some(project_id) => {
            global
                .registry
                .find(project_id)
                .ok_or_else(|| WikiFailure::ProjectNotFound {
                    project_id: project_id.to_owned(),
                })
        }
        None => Err(WikiFailure::CurrentProjectUnset),
    }
}

fn current_project(global: &WikiState) -> Result<&WikiProjectRecord, WikiFailure> {
    selected_project(global, None)
}

fn project_root(project: &WikiProjectRecord) -> &Path {
    Path::new(project.root_path())
}

fn save_state(global: &WikiState) -> Result<(), WikiFailure> {
    write_json(
        global.state_root.join(PROJECT_REGISTRY_FILE),
        &global.registry,
    )?;
    write_json(
        global.state_root.join(CURRENT_PROJECT_FILE),
        &CurrentProjectFile {
            project_id: global.current_project_id.clone(),
        },
    )
}

fn read_source_watch_config(root: &Path) -> Result<WikiSourceWatchConfig, WikiFailure> {
    read_json(root.join(SOURCE_WATCH_CONFIG_FILE))
}

fn write_source_watch_config(
    root: &Path,
    config: &WikiSourceWatchConfig,
) -> Result<(), WikiFailure> {
    write_json(root.join(SOURCE_WATCH_CONFIG_FILE), config)
}

fn normalize_root(path: &str) -> Result<PathBuf, WikiFailure> {
    let root = crate::domain::absolute_clean_path(path)?;
    if root.is_absolute() {
        Ok(root)
    } else {
        root.canonicalize()
            .map_err(|error| WikiFailure::io(path_text(&root), error))
    }
}

fn pending_change_count(root: &Path) -> Result<usize, WikiFailure> {
    Ok(read_json::<Vec<FileChange>>(root.join(FILE_CHANGE_QUEUE))?.len())
}

fn write_file_snapshot(root: &Path) -> Result<(), WikiFailure> {
    ensure_project_layout(root).map_err(|error| WikiFailure::io(path_text(root), error))?;
    let previous = read_json::<FileSnapshot>(root.join(FILE_SNAPSHOT))?;
    let mut current = FileSnapshot::default();
    collect_snapshot_entries(root, root, &mut current.entries)?;

    let mut changes = Vec::new();
    for (path, entry) in &current.entries {
        match previous.entries.get(path) {
            Some(previous_entry) if previous_entry.revision == entry.revision => {}
            Some(_) => changes.push(FileChange::new(
                "modified",
                path.clone(),
                entry.revision.clone(),
            )),
            None => changes.push(FileChange::new(
                "added",
                path.clone(),
                entry.revision.clone(),
            )),
        }
    }
    for path in previous.entries.keys() {
        if !current.entries.contains_key(path) {
            changes.push(FileChange::new("deleted", path.clone(), String::new()));
        }
    }
    write_json(root.join(FILE_SNAPSHOT), &current)?;
    write_json(root.join(FILE_CHANGE_QUEUE), &changes)
}

fn collect_snapshot_entries(
    root: &Path,
    directory: &Path,
    entries: &mut BTreeMap<String, FileSnapshotEntry>,
) -> Result<(), WikiFailure> {
    for entry in std::fs::read_dir(directory)
        .map_err(|error| WikiFailure::io(path_text(directory), error))?
    {
        let entry = entry.map_err(|error| WikiFailure::io(path_text(directory), error))?;
        let path = entry.path();
        let relative_path = path
            .strip_prefix(root)
            .map(crate::domain::normalize_relative_path)
            .unwrap_or_else(|_| path_text(&path));
        let metadata = entry
            .metadata()
            .map_err(|error| WikiFailure::io(path_text(&path), error))?;
        if metadata.is_dir() {
            if is_default_watch_descend_dir(&relative_path) {
                collect_snapshot_entries(root, &path, entries)?;
            }
            continue;
        }
        if !is_default_watch_tracked_file(&relative_path) {
            continue;
        }
        let bytes =
            std::fs::read(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
        entries.insert(
            relative_path,
            FileSnapshotEntry {
                revision: stable_content_hash(&bytes),
                size: metadata.len(),
                modified_at_ms: metadata.modified().map(system_time_ms).unwrap_or_default(),
            },
        );
    }
    Ok(())
}

fn read_json<T: DeserializeOwned + Default>(path: impl AsRef<Path>) -> Result<T, WikiFailure> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(T::default());
    }
    let bytes = std::fs::read(path).map_err(|error| WikiFailure::io(path_text(path), error))?;
    serde_json::from_slice(&bytes).map_err(|error| WikiFailure::state(error.to_string()))
}

fn write_json(path: impl AsRef<Path>, value: &impl Serialize) -> Result<(), WikiFailure> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| WikiFailure::state(error.to_string()))?;
    std::fs::write(path, bytes).map_err(|error| WikiFailure::io(path_text(path), error))
}

fn map_read_error(path: &Path, error: std::io::Error) -> WikiFailure {
    if error.kind() == std::io::ErrorKind::NotFound {
        WikiFailure::not_found(path_text(path))
    } else {
        WikiFailure::io(path_text(path), error)
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Clone, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MineruPrivateConfig {
    token: Option<String>,
    local_token: Option<String>,
    source_urls: BTreeMap<String, String>,
}

fn source_watch_config_with_private_flags(
    global: &WikiState,
    project_id: &str,
    config: WikiSourceWatchConfig,
) -> Result<WikiSourceWatchConfig, WikiFailure> {
    let private = read_mineru_private_config(global, project_id)?;
    Ok(config.with_mineru_private_flags(private.token.is_some(), private.local_token.is_some()))
}

fn read_mineru_private_config(
    global: &WikiState,
    project_id: &str,
) -> Result<MineruPrivateConfig, WikiFailure> {
    read_json(mineru_private_config_path(global, project_id))
}

fn write_mineru_private_config(
    global: &WikiState,
    project_id: &str,
    config: &MineruPrivateConfig,
) -> Result<(), WikiFailure> {
    write_json(mineru_private_config_path(global, project_id), config)
}

fn mineru_private_config_path(global: &WikiState, project_id: &str) -> PathBuf {
    global
        .state_root
        .join("projects")
        .join(project_id)
        .join(MINERU_PRIVATE_CONFIG_FILE)
}

fn apply_private_token_input(target: &mut Option<String>, input: Option<String>) {
    if let Some(token) = input {
        let token = token.trim();
        *target = (!token.is_empty()).then(|| token.to_owned());
    }
}

fn validate_source_watch_config(config: &WikiSourceWatchConfig) -> Result<(), WikiFailure> {
    if config.mineru_enabled() && config.mineru_backend() == "local" {
        local_mineru_api_base(config.mineru_local_endpoint())?;
        if config.mineru_local_backend().ends_with("http-client")
            && config.mineru_local_server_url().trim().is_empty()
        {
            return Err(WikiFailure::invalid_input(
                "mineruLocalServerUrl",
                "MinerU HTTP client backends require a model server URL",
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentProjectFile {
    project_id: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshot {
    entries: BTreeMap<String, FileSnapshotEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshotEntry {
    revision: String,
    size: u64,
    modified_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileChange {
    kind: String,
    relative_path: String,
    revision: String,
}

impl FileChange {
    fn new(kind: &str, relative_path: String, revision: String) -> Self {
        Self {
            kind: kind.to_owned(),
            relative_path,
            revision,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_image(rel_path: &str) -> ImportedImage {
        ImportedImage {
            index: 1,
            mime_type: "image/png".to_owned(),
            page: None,
            width: 0,
            height: 0,
            rel_path: rel_path.to_owned(),
            sha256: "sha-a".to_owned(),
            data_base64: String::new(),
            caption: Some("A visible chart with text Alpha".to_owned()),
        }
    }

    fn test_staged(root: PathBuf) -> WikiStagedImportSource {
        WikiStagedImportSource {
            project_id: "project-a".to_owned(),
            project_root: root.clone(),
            import_id: "import-a".to_owned(),
            source_path: root.join("raw/sources/source.md"),
            source_relative_path: "raw/sources/source.md".to_owned(),
            source_identity: "source.md".to_owned(),
            page_relative_path: "wiki/sources/source.md".to_owned(),
            task_kind: WikiSourceTaskKind::Imported,
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "wiki-actor-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn caption_prompt_uses_nearby_context_without_image_ref() {
        let image = ImportedImage {
            caption: None,
            ..test_image("media/import-a/img-1.png")
        };
        let before = "A".repeat(180);
        let after = "B".repeat(180);
        let text = format!("{before} ![old](../media/import-a/img-1.png) {after}");
        let prompt = image_caption_prompt(Some("English"), &text, &image);

        assert!(prompt.contains("Preserve any visible text verbatim"));
        assert!(prompt.contains(&"A".repeat(120)));
        assert!(prompt.contains(&"B".repeat(120)));
        assert!(!prompt.contains("![old]"));
    }

    #[test]
    fn image_captions_rewrite_near_original_refs() {
        let image = test_image("media/import-a/img-1.png");
        let text = "before ![old](../media/import-a/img-1.png \"Title\") middle ![[media/import-a/img-1.png|300]] after";
        let rewritten = apply_image_captions_to_source_text(text, &[image]);

        assert!(
            rewritten.contains(
                "![A visible chart with text Alpha](../media/import-a/img-1.png \"Title\")"
            )
        );
        assert!(
            rewritten.contains("![A visible chart with text Alpha](../media/import-a/img-1.png)")
        );
        assert!(!rewritten.contains("## Embedded Images"));
    }

    #[test]
    fn flat_caption_cache_entries_migrate_to_rust_schema() {
        let root = temp_root("caption-cache");
        let cache_path = root.join(IMAGE_CAPTION_CACHE_FILE);
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(
            &cache_path,
            r#"{
              "legacy-sha": "Legacy caption",
              "sha-a::language:zh-CN": {
                "caption": "中文 caption",
                "mimeType": "image/png",
                "model": "model-a",
                "capturedAt": "2026-01-01T00:00:00Z"
              },
              "cache-key": {
                "caption": "Object caption",
                "imageHash": "sha-b",
                "outputLanguage": "English"
              }
            }"#,
        )
        .unwrap();

        let cache = read_image_caption_cache(&root).unwrap();
        assert_eq!(cache.caption("legacy-sha", None), Some("Legacy caption"));
        assert_eq!(cache.caption("sha-a", Some("zh-CN")), Some("中文 caption"));
        assert_eq!(
            cache.caption("sha-b", Some("English")),
            Some("Object caption")
        );
    }

    #[test]
    fn embedded_image_section_is_lightweight_and_source_relative() {
        let root = temp_root("embedded-section");
        let staged = test_staged(root);
        let markdown =
            import_source_markdown(&staged, "Body", &[test_image("media/import-a/img-1.png")]);

        assert!(markdown.contains("## Embedded Images"));
        assert!(
            markdown.contains("![A visible chart with text Alpha](../media/import-a/img-1.png)")
        );
        assert!(!markdown.contains("sha-a"));
        assert!(!markdown.contains("image/png"));
        assert!(!markdown.contains("0x0"));
    }

    #[test]
    fn markdown_image_parser_keeps_obsidian_size_target() {
        let text =
            "![alt](a%20b.svg#frag \"Title\") again ![dup](a%20b.svg#frag) obs ![[scan.tiff|300]]";
        let first = next_markdown_image(text).unwrap();
        assert_eq!(first.target, "a%20b.svg#frag");
        let second = next_markdown_image(&text[first.end..]).unwrap();
        assert_eq!(second.target, "a%20b.svg#frag");
        let third = next_markdown_image(&text[first.end + second.end..]).unwrap();
        assert_eq!(third.target, "scan.tiff");
        assert!(third.wikilink);
    }

    #[test]
    fn markdown_local_images_decode_titles_sizes_extensions_and_dedupe() {
        let root = temp_root("local-images");
        let staged = test_staged(root.clone());
        let source_dir = staged.source_path.parent().unwrap();
        std::fs::create_dir_all(source_dir).unwrap();
        std::fs::write(source_dir.join("a b.svg"), b"<svg/>").unwrap();
        std::fs::write(source_dir.join("scan.tiff"), b"tiff").unwrap();

        let text =
            "![alt](a%20b.svg#frag \"Title\") again ![dup](a%20b.svg#frag) obs ![[scan.tiff|300]]";
        assert_eq!(
            clean_local_image_target("a%20b.svg#frag"),
            Some("a b.svg".to_owned())
        );
        assert!(source_dir.join("a b.svg").is_file());
        let (rewritten, images) = extract_markdown_local_images(&staged, text).unwrap();

        assert_eq!(images.len(), 2);
        assert_eq!(images[0].mime_type, "image/svg+xml");
        assert_eq!(images[1].mime_type, "image/tiff");
        assert!(rewritten.contains("![alt](../media/import-a/001-a b.svg \"Title\")"));
        assert!(rewritten.contains("![dup](../media/import-a/001-a b.svg)"));
        assert!(rewritten.contains("![](../media/import-a/002-scan.tiff)"));
    }

    #[test]
    fn mineru_rewrite_handles_html_tables_images_and_markdown_titles() {
        let mut path_map = BTreeMap::new();
        path_map.insert(
            "images/a b.png".to_owned(),
            "media/import-a/mineru/a b.png".to_owned(),
        );
        path_map.insert("b.png".to_owned(), "media/import-a/mineru/b.png".to_owned());
        let markdown = "<table><tr><th>Name</th><th>Pic</th></tr><tr><td>A</td><td><img src='images/a%20b.png' alt='Alt' title='Title'></td></tr></table>\n![Keep](b.png \"T\")";
        let rewritten = rewrite_mineru_markdown_images(markdown, &path_map);

        assert!(rewritten.contains("| Name | Pic |"));
        assert!(rewritten.contains("![Alt](media/import-a/mineru/a%20b.png \"Title\")"));
        assert!(rewritten.contains("![Keep](media/import-a/mineru/b.png \"T\")"));
        assert!(!rewritten.contains("<table"));
    }

    #[test]
    fn recover_imported_images_from_existing_mineru_markdown_refs() {
        let root = temp_root("recover-mineru");
        let staged = test_staged(root.clone());
        let image_dir = root.join("wiki/media/import-a/mineru");
        std::fs::create_dir_all(&image_dir).unwrap();
        let image_bytes = B64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQAFAAH/Ab6kAAAAAElFTkSuQmCC").unwrap();
        std::fs::write(image_dir.join("img.png"), &image_bytes).unwrap();

        let images = recover_imported_markdown_images(
            &staged,
            "![Alt](../media/import-a/mineru/img.png) ![Dup](../media/import-a/mineru/img.png)",
        )
        .unwrap()
        .unwrap();

        assert_eq!(images.len(), 1);
        assert_eq!(images[0].index, 1);
        assert_eq!(
            images[0].rel_path.as_deref(),
            Some("media/import-a/mineru/img.png")
        );
        assert_eq!(images[0].sha256, sha256_hex(&image_bytes));
    }
}
