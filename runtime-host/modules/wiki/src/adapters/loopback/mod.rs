use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::{
    api::WikiHandle,
    domain::{
        WikiApplyGeneratedPagesInput, WikiCancelSourceTaskInput, WikiCreateProjectInput,
        WikiDeleteSourceInput, WikiFailure, WikiFilesInput, WikiGeneratedPageInput,
        WikiImportFolderInput, WikiImportSourceInput, WikiOpenProjectInput, WikiPathSelector,
        WikiProjectSelector, WikiReadBinaryInput, WikiReadInput, WikiRetrieveContextInput,
        WikiReviewClearResolvedInput, WikiReviewDismissInput, WikiReviewResolveInput,
        WikiSearchInput, WikiSourceWatchConfigInput, WikiWriteInput,
        model::{WikiReorderSourceTaskInput, WikiSourceTaskActionInput},
    },
};

const MODULE_ID: ModuleId = ModuleId::new("wiki");
const ROUTE_ID: &str = "wiki.loopback";
const AUTHORIZATION_SCOPE_READ: &str = "wiki:read";
const AUTHORIZATION_SCOPE_WRITE: &str = "wiki:write";
const AUTHORIZATION_CAPABILITY: &str = "wiki";
const AUTHORIZATION_SUBJECT: &str = "wiki";
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);
const WRITE_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_REQUEST_BYTES: usize = 256 * 1024;

const STATUS_PATH: &str = "/api/wiki/status";
const PROJECTS_PATH: &str = "/api/wiki/projects";
const PROJECT_TEMPLATES_PATH: &str = "/api/wiki/project-templates";
const CREATE_PROJECT_PATH: &str = "/api/wiki/project/create";
const OPEN_PROJECT_PATH: &str = "/api/wiki/project/open";
const CURRENT_PROJECT_PATH: &str = "/api/wiki/project/current";
const FILES_PATH: &str = "/api/wiki/files";
const READ_FILE_PATH: &str = "/api/wiki/read-file";
const READ_BINARY_FILE_PATH: &str = "/api/wiki/read-binary-file";
const READ_SOURCE_PREVIEW_PATH: &str = "/api/wiki/read-source-preview";
const WRITE_FILE_PATH: &str = "/api/wiki/write-file";
const SEARCH_PATH: &str = "/api/wiki/search";
const GRAPH_PATH: &str = "/api/wiki/graph";
const RESCAN_SOURCES_PATH: &str = "/api/wiki/rescan-sources";
const REFRESH_SOURCES_PATH: &str = "/api/wiki/refresh-sources";
const IMPORT_SOURCE_PATH: &str = "/api/wiki/import-source";
const IMPORT_FOLDER_PATH: &str = "/api/wiki/import-folder";
const APPLY_GENERATED_PAGES_PATH: &str = "/api/wiki/apply-generated-pages";
const DELETE_SOURCE_PATH: &str = "/api/wiki/delete-source";
const SOURCE_FILES_PATH: &str = "/api/wiki/source-files";
const SOURCE_TASKS_PATH: &str = "/api/wiki/source-tasks";
const CANCEL_SOURCE_TASK_PATH: &str = "/api/wiki/source-task/cancel";
const RETRY_SOURCE_TASK_PATH: &str = "/api/wiki/source-task/retry";
const PAUSE_SOURCE_TASK_PATH: &str = "/api/wiki/source-task/pause";
const RESUME_SOURCE_TASK_PATH: &str = "/api/wiki/source-task/resume";
const REORDER_SOURCE_TASK_PATH: &str = "/api/wiki/source-task/reorder";
const SOURCE_WATCH_CONFIG_PATH: &str = "/api/wiki/source-watch-config";
const REVIEWS_PATH: &str = "/api/wiki/reviews";
const REVIEW_RESOLVE_PATH: &str = "/api/wiki/review/resolve";
const REVIEW_DISMISS_PATH: &str = "/api/wiki/review/dismiss";
const REVIEWS_CLEAR_RESOLVED_PATH: &str = "/api/wiki/reviews/clear-resolved";
const EMBED_PAGE_PATH: &str = "/api/wiki/embed-page";
const RETRIEVE_CONTEXT_PATH: &str = "/api/wiki/retrieve-context";

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    wiki: WikiHandle,
}

impl Dependencies {
    pub fn new(verifier: Arc<Mutex<CapabilityDecisionVerifier>>, wiki: WikiHandle) -> Self {
        Self { verifier, wiki }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        MODULE_ID,
        vec![RouteDescriptor::bound(
            ROUTE_ID,
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    if !is_wiki_path(path) {
        return None;
    }
    let max_bytes = if matches!(path, WRITE_FILE_PATH | APPLY_GENERATED_PAGES_PATH) {
        WRITE_REQUEST_BYTES
    } else {
        DEFAULT_REQUEST_BYTES
    };
    Some(RouteHeadPlan::new(
        match head.method.as_str() {
            "GET" => BodyPolicy::Empty,
            "POST" => BodyPolicy::Required { max_bytes },
            _ => BodyPolicy::Optional { max_bytes },
        },
        DEFAULT_DEADLINE,
        timeout_response,
    ))
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move { handle(dependencies, request).await.into() })
}

async fn handle(dependencies: Dependencies, request: Request) -> Response {
    let path = pathname(request.path());
    let Some(route) = Route::match_request(request.method(), path) else {
        return Response::not_found();
    };
    if !authorize(&dependencies, &request, path, route.scope()).await {
        return Response::error(401, "Wiki authorization is invalid");
    }

    let query = query(request.path());
    match route {
        Route::Status => deliver(dependencies.wiki.status().await),
        Route::Projects => deliver(dependencies.wiki.projects().await),
        Route::ProjectTemplates => deliver(dependencies.wiki.project_templates().await),
        Route::CurrentProject => match dependencies.wiki.status().await {
            Ok(status) => Response::json(200, json!({ "project": status.current_project() })),
            Err(error) => failure(error),
        },
        Route::Files => {
            let input = WikiFilesInput {
                project_id: query_value(query, "projectId"),
                directory: query_value(query, "directory").unwrap_or_default(),
            };
            deliver(dependencies.wiki.files(input).await)
        }
        Route::Graph => deliver(
            dependencies
                .wiki
                .graph(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::CreateProject => {
            let Some(input) = decode_body::<ProjectInput>(&request).and_then(ProjectInput::create)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.create_project(input).await)
        }
        Route::OpenProject => {
            let Some(input) = decode_body::<ProjectInput>(&request).and_then(ProjectInput::open)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.open_project(input).await)
        }
        Route::ReadFile => {
            let Some(input) = decode_body::<PathInput>(&request).and_then(PathInput::read) else {
                return invalid();
            };
            deliver(dependencies.wiki.read(input).await)
        }
        Route::ReadBinaryFile => {
            let Some(input) = decode_body::<PathInput>(&request).and_then(PathInput::read_binary)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.read_binary(input).await)
        }
        Route::ReadSourcePreview => {
            let Some(input) = decode_body::<PathInput>(&request).and_then(PathInput::read) else {
                return invalid();
            };
            deliver(dependencies.wiki.read_source_preview(input).await)
        }
        Route::WriteFile => {
            let Some(input) = decode_body::<WriteInput>(&request).and_then(WriteInput::write)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.write(input).await)
        }
        Route::Search => {
            let Some(input) = decode_body::<SearchInput>(&request).and_then(SearchInput::search)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.search(input).await)
        }
        Route::RescanSources => {
            let input = decode_body::<ProjectInput>(&request)
                .map(ProjectInput::selector)
                .unwrap_or(WikiProjectSelector { project_id: None });
            deliver(dependencies.wiki.rescan(input).await)
        }
        Route::RefreshSources => {
            let input = decode_body::<ProjectInput>(&request)
                .map(ProjectInput::selector)
                .unwrap_or(WikiProjectSelector { project_id: None });
            deliver(dependencies.wiki.refresh_sources(input).await)
        }
        Route::SourceTasks => {
            let input = decode_body::<ProjectInput>(&request)
                .map(ProjectInput::selector)
                .unwrap_or(WikiProjectSelector { project_id: None });
            deliver(dependencies.wiki.source_tasks(input).await)
        }
        Route::CancelSourceTask => {
            let Some(input) = decode_body::<WikiCancelSourceTaskInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.cancel_source_task(input).await)
        }
        Route::RetrySourceTask => {
            let Some(input) = decode_body::<WikiSourceTaskActionInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.retry_source_task(input).await)
        }
        Route::PauseSourceTask => {
            let Some(input) = decode_body::<WikiSourceTaskActionInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.pause_source_task(input).await)
        }
        Route::ResumeSourceTask => {
            let Some(input) = decode_body::<WikiSourceTaskActionInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.resume_source_task(input).await)
        }
        Route::ReorderSourceTask => {
            let Some(input) = decode_body::<WikiReorderSourceTaskInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.reorder_source_task(input).await)
        }
        Route::SourceFiles => deliver(
            dependencies
                .wiki
                .source_files(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::SourceWatchConfig => deliver(
            dependencies
                .wiki
                .source_watch_config(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::Reviews => deliver(
            dependencies
                .wiki
                .reviews(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::UpdateSourceWatchConfig => {
            let Some(input) = decode_body::<WikiSourceWatchConfigInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.update_source_watch_config(input).await)
        }
        Route::ResolveReview => {
            let Some(input) = decode_body::<WikiReviewResolveInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.resolve_review(input).await)
        }
        Route::DismissReview => {
            let Some(input) = decode_body::<WikiReviewDismissInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.dismiss_review(input).await)
        }
        Route::ClearResolvedReviews => {
            let Some(input) = decode_body::<WikiReviewClearResolvedInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.clear_resolved_reviews(input).await)
        }
        Route::ImportSource => {
            let Some(input) =
                decode_body::<ImportSourceInput>(&request).and_then(ImportSourceInput::import)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.import_source(input).await)
        }
        Route::ImportFolder => {
            let Some(input) =
                decode_body::<ImportFolderInput>(&request).and_then(ImportFolderInput::import)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.import_folder(input).await)
        }
        Route::ApplyGeneratedPages => {
            let Some(input) = decode_body::<ApplyGeneratedPagesInput>(&request)
                .and_then(ApplyGeneratedPagesInput::apply)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.apply_generated_pages(input).await)
        }
        Route::DeleteSource => {
            let Some(input) =
                decode_body::<DeleteSourceInput>(&request).and_then(DeleteSourceInput::delete)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.delete_source(input).await)
        }
        Route::EmbedPage => {
            let Some(input) = decode_body::<PathInput>(&request).and_then(PathInput::selector)
            else {
                return invalid();
            };
            deliver_unit(dependencies.wiki.embed_page(input).await)
        }
        Route::RetrieveContext => {
            let Some(input) = decode_body::<SearchInput>(&request).and_then(SearchInput::retrieve)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.retrieve_context(input).await)
        }
    }
}

#[derive(Clone, Copy)]
enum Route {
    Status,
    Projects,
    ProjectTemplates,
    CreateProject,
    OpenProject,
    CurrentProject,
    Files,
    ReadFile,
    ReadBinaryFile,
    ReadSourcePreview,
    WriteFile,
    Search,
    Graph,
    RescanSources,
    RefreshSources,
    ImportSource,
    ImportFolder,
    ApplyGeneratedPages,
    DeleteSource,
    SourceFiles,
    SourceTasks,
    CancelSourceTask,
    RetrySourceTask,
    PauseSourceTask,
    ResumeSourceTask,
    ReorderSourceTask,
    SourceWatchConfig,
    UpdateSourceWatchConfig,
    Reviews,
    ResolveReview,
    DismissReview,
    ClearResolvedReviews,
    EmbedPage,
    RetrieveContext,
}

impl Route {
    fn match_request(method: &str, path: &str) -> Option<Self> {
        Some(match (method, path) {
            ("GET", STATUS_PATH) => Self::Status,
            ("GET", PROJECTS_PATH) => Self::Projects,
            ("GET", PROJECT_TEMPLATES_PATH) => Self::ProjectTemplates,
            ("POST", CREATE_PROJECT_PATH) => Self::CreateProject,
            ("POST", OPEN_PROJECT_PATH) => Self::OpenProject,
            ("GET", CURRENT_PROJECT_PATH) => Self::CurrentProject,
            ("GET", FILES_PATH) => Self::Files,
            ("POST", READ_FILE_PATH) => Self::ReadFile,
            ("POST", READ_BINARY_FILE_PATH) => Self::ReadBinaryFile,
            ("POST", READ_SOURCE_PREVIEW_PATH) => Self::ReadSourcePreview,
            ("POST", WRITE_FILE_PATH) => Self::WriteFile,
            ("POST", SEARCH_PATH) => Self::Search,
            ("GET", GRAPH_PATH) => Self::Graph,
            ("POST", RESCAN_SOURCES_PATH) => Self::RescanSources,
            ("POST", REFRESH_SOURCES_PATH) => Self::RefreshSources,
            ("POST", IMPORT_SOURCE_PATH) => Self::ImportSource,
            ("POST", IMPORT_FOLDER_PATH) => Self::ImportFolder,
            ("POST", APPLY_GENERATED_PAGES_PATH) => Self::ApplyGeneratedPages,
            ("POST", DELETE_SOURCE_PATH) => Self::DeleteSource,
            ("GET", SOURCE_FILES_PATH) => Self::SourceFiles,
            ("POST", SOURCE_TASKS_PATH) => Self::SourceTasks,
            ("POST", CANCEL_SOURCE_TASK_PATH) => Self::CancelSourceTask,
            ("POST", RETRY_SOURCE_TASK_PATH) => Self::RetrySourceTask,
            ("POST", PAUSE_SOURCE_TASK_PATH) => Self::PauseSourceTask,
            ("POST", RESUME_SOURCE_TASK_PATH) => Self::ResumeSourceTask,
            ("POST", REORDER_SOURCE_TASK_PATH) => Self::ReorderSourceTask,
            ("GET", SOURCE_WATCH_CONFIG_PATH) => Self::SourceWatchConfig,
            ("POST", SOURCE_WATCH_CONFIG_PATH) => Self::UpdateSourceWatchConfig,
            ("GET", REVIEWS_PATH) => Self::Reviews,
            ("POST", REVIEW_RESOLVE_PATH) => Self::ResolveReview,
            ("POST", REVIEW_DISMISS_PATH) => Self::DismissReview,
            ("POST", REVIEWS_CLEAR_RESOLVED_PATH) => Self::ClearResolvedReviews,
            ("POST", EMBED_PAGE_PATH) => Self::EmbedPage,
            ("POST", RETRIEVE_CONTEXT_PATH) => Self::RetrieveContext,
            _ => return None,
        })
    }

    const fn scope(self) -> &'static str {
        match self {
            Self::CreateProject
            | Self::OpenProject
            | Self::WriteFile
            | Self::RescanSources
            | Self::RefreshSources
            | Self::ImportSource
            | Self::ImportFolder
            | Self::ApplyGeneratedPages
            | Self::DeleteSource
            | Self::UpdateSourceWatchConfig
            | Self::CancelSourceTask
            | Self::RetrySourceTask
            | Self::PauseSourceTask
            | Self::ResumeSourceTask
            | Self::ReorderSourceTask
            | Self::ResolveReview
            | Self::DismissReview
            | Self::ClearResolvedReviews
            | Self::EmbedPage => AUTHORIZATION_SCOPE_WRITE,
            Self::Status
            | Self::Projects
            | Self::ProjectTemplates
            | Self::CurrentProject
            | Self::Files
            | Self::ReadFile
            | Self::ReadBinaryFile
            | Self::ReadSourcePreview
            | Self::Search
            | Self::Graph
            | Self::SourceFiles
            | Self::SourceTasks
            | Self::SourceWatchConfig
            | Self::Reviews
            | Self::RetrieveContext => AUTHORIZATION_SCOPE_READ,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInput {
    project_id: Option<String>,
    root_path: Option<String>,
    path: Option<String>,
    title: Option<String>,
    name: Option<String>,
    template_id: Option<String>,
}

impl ProjectInput {
    fn create(self) -> Option<WikiCreateProjectInput> {
        Some(WikiCreateProjectInput {
            root_path: self.root_path.or(self.path)?,
            title: self.title.or(self.name),
            template_id: self.template_id,
        })
    }

    fn open(self) -> Option<WikiOpenProjectInput> {
        Some(WikiOpenProjectInput {
            root_path: self.root_path.or(self.path)?,
            title: self.title.or(self.name),
        })
    }

    fn selector(self) -> WikiProjectSelector {
        WikiProjectSelector {
            project_id: self.project_id,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathInput {
    project_id: Option<String>,
    relative_path: Option<String>,
    path: Option<String>,
    limit: Option<usize>,
    max_bytes: Option<usize>,
}

impl PathInput {
    fn read(self) -> Option<WikiReadInput> {
        Some(WikiReadInput {
            project_id: self.project_id,
            relative_path: self.relative_path.or(self.path)?,
            limit: self.limit.unwrap_or(0),
        })
    }

    fn read_binary(self) -> Option<WikiReadBinaryInput> {
        Some(WikiReadBinaryInput {
            project_id: self.project_id,
            relative_path: self.relative_path.or(self.path)?,
            max_bytes: self.max_bytes.unwrap_or(0),
        })
    }

    fn selector(self) -> Option<WikiPathSelector> {
        Some(WikiPathSelector {
            project_id: self.project_id,
            relative_path: self.relative_path.or(self.path)?,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteInput {
    project_id: Option<String>,
    relative_path: Option<String>,
    path: Option<String>,
    content: String,
}

impl WriteInput {
    fn write(self) -> Option<WikiWriteInput> {
        Some(WikiWriteInput {
            project_id: self.project_id,
            relative_path: self.relative_path.or(self.path)?,
            content: self.content,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportSourceInput {
    project_id: Option<String>,
    source_path: String,
}

impl ImportSourceInput {
    fn import(self) -> Option<WikiImportSourceInput> {
        (!self.source_path.trim().is_empty()).then(|| WikiImportSourceInput {
            project_id: self.project_id,
            source_path: self.source_path,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportFolderInput {
    project_id: Option<String>,
    folder_path: String,
}

impl ImportFolderInput {
    fn import(self) -> Option<WikiImportFolderInput> {
        (!self.folder_path.trim().is_empty()).then(|| WikiImportFolderInput {
            project_id: self.project_id,
            folder_path: self.folder_path,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteSourceInput {
    project_id: Option<String>,
    source_path: String,
    file_already_deleted: Option<bool>,
}

impl DeleteSourceInput {
    fn delete(self) -> Option<WikiDeleteSourceInput> {
        (!self.source_path.trim().is_empty()).then(|| WikiDeleteSourceInput {
            project_id: self.project_id,
            source_path: self.source_path,
            file_already_deleted: self.file_already_deleted.unwrap_or(false),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyGeneratedPagesInput {
    project_id: Option<String>,
    source_path: String,
    files: Vec<WikiGeneratedPageInput>,
}

impl ApplyGeneratedPagesInput {
    fn apply(self) -> Option<WikiApplyGeneratedPagesInput> {
        (!self.source_path.trim().is_empty()).then(|| WikiApplyGeneratedPagesInput {
            project_id: self.project_id,
            source_path: self.source_path,
            files: self.files,
            reviews: Vec::new(),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchInput {
    project_id: Option<String>,
    query: String,
    limit: Option<usize>,
}

impl SearchInput {
    fn search(self) -> Option<WikiSearchInput> {
        (!self.query.trim().is_empty()).then(|| WikiSearchInput {
            project_id: self.project_id,
            query: self.query,
            limit: self.limit.unwrap_or(20),
        })
    }

    fn retrieve(self) -> Option<WikiRetrieveContextInput> {
        (!self.query.trim().is_empty()).then(|| WikiRetrieveContextInput {
            project_id: self.project_id,
            query: self.query,
            limit: self.limit.unwrap_or(8),
        })
    }
}

async fn authorize(
    dependencies: &Dependencies,
    request: &Request,
    endpoint: &str,
    scope: &str,
) -> bool {
    let Some(authorization) = request.bearer_authorization() else {
        return false;
    };
    dependencies
        .verifier
        .lock()
        .await
        .verify(
            authorization,
            now_millis(),
            endpoint,
            scope,
            AUTHORIZATION_CAPABILITY,
            AUTHORIZATION_SUBJECT,
        )
        .is_ok()
}

fn decode_body<T: for<'de> Deserialize<'de>>(request: &Request) -> Option<T> {
    serde_json::from_slice(&request.body).ok()
}

fn deliver<T: serde::Serialize>(result: Result<T, WikiFailure>) -> Response {
    match result {
        Ok(value) => Response::json(200, json!(value)),
        Err(error) => failure(error),
    }
}

fn deliver_unit(result: Result<(), WikiFailure>) -> Response {
    match result {
        Ok(()) => Response::json(200, json!({ "success": true })),
        Err(error) => failure(error),
    }
}

fn failure(error: WikiFailure) -> Response {
    Response::json(
        status_code(&error),
        json!({ "success": false, "error": error_message(&error), "failure": error }),
    )
}

fn invalid() -> Response {
    Response::error(400, "Wiki request is invalid")
}

fn timeout_response() -> Response {
    Response::error(503, "Runtime Host request deadline exceeded")
}

fn status_code(error: &WikiFailure) -> u16 {
    match error {
        WikiFailure::NotFound { .. } | WikiFailure::ProjectNotFound { .. } => 404,
        WikiFailure::Cancelled => 409,
        WikiFailure::CurrentProjectUnset => 409,
        WikiFailure::InvalidInput { .. }
        | WikiFailure::InvalidPath { .. }
        | WikiFailure::PathOutsideProject { .. }
        | WikiFailure::IsDirectory { .. }
        | WikiFailure::NotText { .. } => 400,
        WikiFailure::OwnerUnavailable
        | WikiFailure::StateUnavailable { .. }
        | WikiFailure::Io { .. }
        | WikiFailure::IndexUnavailable { .. } => 503,
    }
}

fn error_message(error: &WikiFailure) -> String {
    match error {
        WikiFailure::OwnerUnavailable => "Wiki owner is unavailable".to_owned(),
        WikiFailure::Cancelled => "Wiki source import was cancelled".to_owned(),
        WikiFailure::StateUnavailable { message } => message.clone(),
        WikiFailure::CurrentProjectUnset => "Current wiki project is not set".to_owned(),
        WikiFailure::ProjectNotFound { project_id } => {
            format!("Wiki project not found: {project_id}")
        }
        WikiFailure::InvalidInput { field, message } => format!("Invalid {field}: {message}"),
        WikiFailure::InvalidPath { path } => format!("Invalid wiki path: {path}"),
        WikiFailure::PathOutsideProject { path } => format!("Wiki path is outside project: {path}"),
        WikiFailure::NotFound { path } => format!("Wiki path not found: {path}"),
        WikiFailure::IsDirectory { path } => format!("Wiki path is a directory: {path}"),
        WikiFailure::NotText { path } => format!("Wiki file is not text: {path}"),
        WikiFailure::Io { path, message } => format!("Wiki file error at {path}: {message}"),
        WikiFailure::IndexUnavailable { backend, reason } => {
            format!("Wiki index backend {backend} is unavailable: {reason}")
        }
    }
}

fn is_wiki_path(path: &str) -> bool {
    matches!(
        path,
        STATUS_PATH
            | PROJECTS_PATH
            | PROJECT_TEMPLATES_PATH
            | CREATE_PROJECT_PATH
            | OPEN_PROJECT_PATH
            | CURRENT_PROJECT_PATH
            | FILES_PATH
            | READ_FILE_PATH
            | READ_BINARY_FILE_PATH
            | READ_SOURCE_PREVIEW_PATH
            | WRITE_FILE_PATH
            | SEARCH_PATH
            | GRAPH_PATH
            | RESCAN_SOURCES_PATH
            | REFRESH_SOURCES_PATH
            | IMPORT_SOURCE_PATH
            | IMPORT_FOLDER_PATH
            | APPLY_GENERATED_PAGES_PATH
            | DELETE_SOURCE_PATH
            | SOURCE_FILES_PATH
            | SOURCE_TASKS_PATH
            | CANCEL_SOURCE_TASK_PATH
            | RETRY_SOURCE_TASK_PATH
            | PAUSE_SOURCE_TASK_PATH
            | RESUME_SOURCE_TASK_PATH
            | REORDER_SOURCE_TASK_PATH
            | SOURCE_WATCH_CONFIG_PATH
            | REVIEWS_PATH
            | REVIEW_RESOLVE_PATH
            | REVIEW_DISMISS_PATH
            | REVIEWS_CLEAR_RESOLVED_PATH
            | EMBED_PAGE_PATH
            | RETRIEVE_CONTEXT_PATH
    )
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn query(path: &str) -> Option<&str> {
    path.split_once('?').map(|(_, query)| query)
}

fn query_value(query: Option<&str>, name: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| decode_query_value(value))
    })
}

fn decode_query_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    output.push(byte);
                    index += 3;
                } else {
                    output.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use platform::loopback::{BodyPolicy, RequestHead};

    use super::*;

    #[test]
    fn source_task_lifecycle_routes_are_planned() {
        for path in [
            CANCEL_SOURCE_TASK_PATH,
            RETRY_SOURCE_TASK_PATH,
            PAUSE_SOURCE_TASK_PATH,
            RESUME_SOURCE_TASK_PATH,
            REORDER_SOURCE_TASK_PATH,
        ] {
            let plan = head_plan(&RequestHead::new(
                "POST".to_owned(),
                path.to_owned(),
                Vec::new(),
                false,
                None,
                None,
            ))
            .expect("wiki source task route should be available");
            assert!(matches!(plan.body_policy(), BodyPolicy::Required { .. }));
        }
    }

    #[test]
    fn review_write_routes_are_planned() {
        for path in [
            REVIEW_RESOLVE_PATH,
            REVIEW_DISMISS_PATH,
            REVIEWS_CLEAR_RESOLVED_PATH,
        ] {
            assert!(
                head_plan(&RequestHead::new(
                    "POST".to_owned(),
                    path.to_owned(),
                    Vec::new(),
                    false,
                    None,
                    None,
                ))
                .is_some()
            );
        }
    }
}
