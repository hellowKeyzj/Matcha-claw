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
const SEARCH_CONFIG_PATH: &str = "/api/wiki/search-config";
const SEARCH_PROVIDER_TEST_PATH: &str = "/api/wiki/search-provider/test";
const RESEARCH_TASKS_PATH: &str = "/api/wiki/research-tasks";
const RESEARCH_START_PATH: &str = "/api/wiki/research/start";
const RESEARCH_RERUN_PATH: &str = "/api/wiki/research-task/rerun";
const RESEARCH_REMOVE_PATH: &str = "/api/wiki/research-task/remove";
const SEARCH_PATH: &str = "/api/wiki/search";
const GRAPH_PATH: &str = "/api/wiki/graph";
const RESCAN_SOURCES_PATH: &str = "/api/wiki/rescan-sources";
const REFRESH_SOURCES_PATH: &str = "/api/wiki/refresh-sources";
const IMPORT_SOURCE_PATH: &str = "/api/wiki/import-source";
const IMPORT_FOLDER_PATH: &str = "/api/wiki/import-folder";
const APPLY_GENERATED_PAGES_PATH: &str = "/api/wiki/apply-generated-pages";
const DELETE_SOURCE_PATH: &str = "/api/wiki/delete-source";
const CALL_RESULT_PATH: &str = "/api/wiki/call-result";
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
const HISTORY_LIST_PATH: &str = "/api/wiki/history/list";
const HISTORY_RESTORE_PATH: &str = "/api/wiki/history/restore";
const HISTORY_STATS_PATH: &str = "/api/wiki/history/stats";
const HISTORY_CONFIG_PATH: &str = "/api/wiki/history/config";
const HISTORY_CLEAR_PATH: &str = "/api/wiki/history/clear";
const EXPORT_ARCHIVE_PATH: &str = "/api/wiki/project/export-archive";
const IMPORT_ARCHIVE_PATH: &str = "/api/wiki/project/import-archive";
const REBUILD_INDEX_PATH: &str = "/api/wiki/rebuild-index";
const ASK_QUESTION_PATH: &str = "/api/wiki/qa/ask";
const QUESTION_TASK_PATH: &str = "/api/wiki/qa/task";
const CANCEL_QUESTION_PATH: &str = "/api/wiki/qa/cancel";
const SAVE_QUESTION_PATH: &str = "/api/wiki/qa/save";
const LINT_CONFIG_PATH: &str = "/api/wiki/lint/config";
const LINT_STATE_PATH: &str = "/api/wiki/lint/state";
const RUN_LINT_PATH: &str = "/api/wiki/lint/run";
const CANCEL_LINT_PATH: &str = "/api/wiki/lint/cancel";
const FIX_LINT_PATH: &str = "/api/wiki/lint/fix";
const REVIEW_LINT_PATH: &str = "/api/wiki/lint/review";
const DELETE_LINT_PATH: &str = "/api/wiki/lint/delete";
const DISMISS_LINT_PATH: &str = "/api/wiki/lint/dismiss";
const REINDEX_PATH: &str = "/api/wiki/embedding/reindex";
const GRAPH_INSIGHTS_PATH: &str = "/api/wiki/graph/insights";
const DISMISS_GRAPH_INSIGHT_PATH: &str = "/api/wiki/graph/insights/dismiss";
const GRAPH_INSIGHT_RESEARCH_PATH: &str = "/api/wiki/graph/insights/research-input";

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
    let plan = if Route::match_request(&head.method, path).is_some_and(|route| {
        route.scope() == AUTHORIZATION_SCOPE_WRITE && !matches!(route, Route::CallResult)
    }) {
        RouteHeadPlan::body_deadline
    } else {
        RouteHeadPlan::new
    };
    Some(plan(
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
        Route::ResearchTasks => deliver(
            dependencies
                .wiki
                .research_tasks(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::StartResearch => {
            let Some(input) = decode_body::<crate::research::WikiResearchInput>(&request) else {
                return invalid();
            };
            admit(dependencies.wiki.start_research(input).await)
        }
        Route::RerunResearch => {
            let Some(input) = decode_body::<crate::research::WikiResearchTaskActionInput>(&request)
            else {
                return invalid();
            };
            admit(dependencies.wiki.rerun_research(input).await)
        }
        Route::RemoveResearchTask => {
            let Some(input) = decode_body::<crate::research::WikiResearchRemoveInput>(&request)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.remove_research_task(input).await)
        }
        Route::SearchConfig => {
            let project_id = match selected_project_id(
                &dependencies.wiki,
                query_value(query, "projectId"),
            )
            .await
            {
                Ok(id) => id,
                Err(error) => return failure(error),
            };
            match dependencies
                .wiki
                .search_config(WikiProjectSelector {
                    project_id: Some(project_id.clone()),
                })
                .await
            {
                Ok(config) => {
                    Response::json(200, json!({ "projectId": project_id, "config": config }))
                }
                Err(error) => failure(error),
            }
        }
        Route::UpdateSearchConfig => {
            let Some((project_id, input)) =
                decode_project_body::<crate::search_config::SearchConfigUpdate>(&request)
            else {
                return invalid();
            };
            let project_id = match selected_project_id(&dependencies.wiki, project_id).await {
                Ok(id) => id,
                Err(error) => return failure(error),
            };
            match dependencies
                .wiki
                .update_search_config(Some(project_id.clone()), input)
                .await
            {
                Ok(config) => {
                    Response::json(200, json!({ "projectId": project_id, "config": config }))
                }
                Err(error) => failure(error),
            }
        }
        Route::TestSearchProvider => {
            let Some((project_id, input)) =
                decode_project_body::<crate::external_search::SearchProviderTest>(&request)
            else {
                return invalid();
            };
            let project_id = match selected_project_id(&dependencies.wiki, project_id).await {
                Ok(id) => id,
                Err(error) => return failure(error),
            };
            match dependencies
                .wiki
                .test_search_provider(Some(project_id.clone()), input)
                .await
            {
                Ok(results) => {
                    Response::json(200, json!({ "projectId": project_id, "results": results }))
                }
                Err(error) => failure(error),
            }
        }
        Route::HistoryList => {
            let Some(input) = decode_body::<crate::history::WikiFileHistoryInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.history_list(input).await)
        }
        Route::RestoreHistory => {
            let Some(input) = decode_body::<crate::history::WikiRestoreFileHistoryInput>(&request)
            else {
                return invalid();
            };
            admit(dependencies.wiki.admit_restore_history(input).await)
        }
        Route::HistoryStats => deliver(
            dependencies
                .wiki
                .history_stats(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::HistoryConfig => deliver(
            dependencies
                .wiki
                .history_config(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::UpdateHistoryConfig => {
            let Some(body) = decode_body::<serde_json::Map<String, serde_json::Value>>(&request)
            else {
                return invalid();
            };
            if body
                .keys()
                .any(|key| !matches!(key.as_str(), "projectId" | "enabled" | "maxVersionsPerFile"))
                || !body.contains_key("enabled")
                || !body.contains_key("maxVersionsPerFile")
            {
                return invalid();
            }
            let Ok(input) =
                serde_json::from_value::<crate::history::WikiFileHistorySettingsInput>(body.into())
            else {
                return invalid();
            };
            deliver(dependencies.wiki.update_history_config(input).await)
        }
        Route::ClearHistory | Route::RebuildIndex => {
            let Some(body) = decode_body::<serde_json::Map<String, serde_json::Value>>(&request)
            else {
                return invalid();
            };
            if body.keys().any(|key| key != "projectId") {
                return invalid();
            }
            let Ok(input) = serde_json::from_value::<WikiProjectSelector>(body.into()) else {
                return invalid();
            };
            admit(match route {
                Route::ClearHistory => dependencies.wiki.admit_clear_history(input).await,
                _ => dependencies.wiki.admit_rebuild_index(input).await,
            })
        }
        Route::ExportArchive => {
            let Some(input) = decode_body::<crate::domain::WikiArchiveExportInput>(&request) else {
                return invalid();
            };
            admit(dependencies.wiki.admit_export_archive(input).await)
        }
        Route::ImportArchive => {
            let Some(input) = decode_body::<crate::domain::WikiArchiveImportInput>(&request) else {
                return invalid();
            };
            admit(dependencies.wiki.admit_import_archive(input).await)
        }
        Route::AskQuestion => {
            let Some(input) = decode_body::<crate::domain::WikiQuestionInput>(&request) else {
                return invalid();
            };
            admit(dependencies.wiki.ask_question(input).await)
        }
        Route::QuestionTask => {
            let Some(task_id) = query_value(query, "taskId") else {
                return invalid();
            };
            deliver(
                dependencies
                    .wiki
                    .question_task(crate::domain::WikiQuestionTaskSelector {
                        project_id: query_value(query, "projectId"),
                        task_id,
                    })
                    .await,
            )
        }
        Route::CancelQuestion => {
            let Some(input) = decode_body::<crate::domain::WikiQuestionTaskSelector>(&request)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.cancel_question(input).await)
        }
        Route::SaveQuestion => {
            let Some(input) = decode_body::<crate::domain::WikiQuestionTaskSelector>(&request)
            else {
                return invalid();
            };
            admit(dependencies.wiki.admit_save_question(input).await)
        }
        Route::LintConfig => deliver(
            dependencies
                .wiki
                .lint_config(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::LintState => deliver(
            dependencies
                .wiki
                .lint_state(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::UpdateLintConfig => {
            let Some(input) = decode_body::<crate::lint::WikiLintConfigInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.update_lint_config(input).await)
        }
        Route::RunLint => {
            let Some(input) = decode_body::<crate::lint::WikiLintRunInput>(&request) else {
                return invalid();
            };
            admit(dependencies.wiki.admit_lint_run(input).await)
        }
        Route::CancelLint => {
            let Some(input) = decode_body::<crate::lint::WikiLintCancelInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.cancel_lint(input).await)
        }
        Route::FixLint | Route::ReviewLint | Route::DeleteLint => {
            let Some(input) = decode_body::<crate::lint::WikiLintActionInput>(&request) else {
                return invalid();
            };
            admit(match route {
                Route::FixLint => dependencies.wiki.admit_lint_fix(input).await,
                Route::ReviewLint => dependencies.wiki.admit_lint_review(input).await,
                _ => dependencies.wiki.admit_lint_delete(input).await,
            })
        }
        Route::DismissLint => {
            let Some(input) = decode_body::<crate::lint::WikiLintActionInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.dismiss_lint(input).await)
        }
        Route::ReindexState => deliver(
            dependencies
                .wiki
                .reindex_state(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::StartReindex => {
            let Some(input) = decode_body::<crate::reindex::WikiReindexInput>(&request) else {
                return invalid();
            };
            admit(dependencies.wiki.admit_reindex(input).await)
        }
        Route::GraphInsights => deliver(
            dependencies
                .wiki
                .graph_insights(WikiProjectSelector {
                    project_id: query_value(query, "projectId"),
                })
                .await,
        ),
        Route::DismissGraphInsight => {
            let Some(input) = decode_body::<crate::insights::WikiGraphInsightInput>(&request)
            else {
                return invalid();
            };
            deliver(dependencies.wiki.dismiss_graph_insight(input).await)
        }
        Route::GraphInsightResearchInput => {
            let Some(input) =
                decode_body::<crate::insights::WikiGraphInsightResearchInput>(&request)
            else {
                return invalid();
            };
            admit(
                dependencies
                    .wiki
                    .admit_graph_insight_research_input(input)
                    .await,
            )
        }
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
            admit(dependencies.wiki.admit_rescan(input).await)
        }
        Route::RefreshSources => {
            let input = decode_body::<ProjectInput>(&request)
                .map(ProjectInput::selector)
                .unwrap_or(WikiProjectSelector { project_id: None });
            admit(dependencies.wiki.admit_refresh_sources(input).await)
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
            admit(dependencies.wiki.admit_retry_source_task(input).await)
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
            admit(dependencies.wiki.admit_resume_source_task(input).await)
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
            admit(dependencies.wiki.admit_import_source(input).await)
        }
        Route::ImportFolder => {
            let Some(input) =
                decode_body::<ImportFolderInput>(&request).and_then(ImportFolderInput::import)
            else {
                return invalid();
            };
            admit(dependencies.wiki.admit_import_folder(input).await)
        }
        Route::ApplyGeneratedPages => {
            let Some(input) = decode_body::<ApplyGeneratedPagesInput>(&request)
                .and_then(ApplyGeneratedPagesInput::apply)
            else {
                return invalid();
            };
            admit(dependencies.wiki.admit_apply_generated_pages(input).await)
        }
        Route::DeleteSource => {
            let Some(input) =
                decode_body::<DeleteSourceInput>(&request).and_then(DeleteSourceInput::delete)
            else {
                return invalid();
            };
            admit(dependencies.wiki.admit_delete_source(input).await)
        }
        Route::CallResult => {
            let Some(input) = decode_body::<CallResultInput>(&request) else {
                return invalid();
            };
            deliver(dependencies.wiki.call_result(&input.call_id))
        }
        Route::EmbedPage => {
            let Some(input) = decode_body::<PathInput>(&request).and_then(PathInput::selector)
            else {
                return invalid();
            };
            admit(dependencies.wiki.admit_embed_page(input).await)
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
    ResearchTasks,
    StartResearch,
    RerunResearch,
    RemoveResearchTask,
    SearchConfig,
    UpdateSearchConfig,
    TestSearchProvider,
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
    CallResult,
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
    HistoryList,
    RestoreHistory,
    HistoryStats,
    HistoryConfig,
    UpdateHistoryConfig,
    ClearHistory,
    ExportArchive,
    ImportArchive,
    RebuildIndex,
    AskQuestion,
    QuestionTask,
    CancelQuestion,
    SaveQuestion,
    LintConfig,
    LintState,
    UpdateLintConfig,
    RunLint,
    CancelLint,
    FixLint,
    ReviewLint,
    DeleteLint,
    DismissLint,
    ReindexState,
    StartReindex,
    GraphInsights,
    DismissGraphInsight,
    GraphInsightResearchInput,
}

impl Route {
    fn match_request(method: &str, path: &str) -> Option<Self> {
        Some(match (method, path) {
            ("GET", SEARCH_CONFIG_PATH) => Self::SearchConfig,
            ("POST", SEARCH_CONFIG_PATH) => Self::UpdateSearchConfig,
            ("POST", SEARCH_PROVIDER_TEST_PATH) => Self::TestSearchProvider,
            ("GET", RESEARCH_TASKS_PATH) => Self::ResearchTasks,
            ("POST", RESEARCH_START_PATH) => Self::StartResearch,
            ("POST", RESEARCH_RERUN_PATH) => Self::RerunResearch,
            ("POST", RESEARCH_REMOVE_PATH) => Self::RemoveResearchTask,
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
            ("POST", CALL_RESULT_PATH) => Self::CallResult,
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
            ("POST", HISTORY_LIST_PATH) => Self::HistoryList,
            ("POST", HISTORY_RESTORE_PATH) => Self::RestoreHistory,
            ("GET", HISTORY_STATS_PATH) => Self::HistoryStats,
            ("GET", HISTORY_CONFIG_PATH) => Self::HistoryConfig,
            ("POST", HISTORY_CONFIG_PATH) => Self::UpdateHistoryConfig,
            ("POST", HISTORY_CLEAR_PATH) => Self::ClearHistory,
            ("POST", EXPORT_ARCHIVE_PATH) => Self::ExportArchive,
            ("POST", IMPORT_ARCHIVE_PATH) => Self::ImportArchive,
            ("POST", REBUILD_INDEX_PATH) => Self::RebuildIndex,
            ("POST", ASK_QUESTION_PATH) => Self::AskQuestion,
            ("GET", QUESTION_TASK_PATH) => Self::QuestionTask,
            ("POST", CANCEL_QUESTION_PATH) => Self::CancelQuestion,
            ("POST", SAVE_QUESTION_PATH) => Self::SaveQuestion,
            ("GET", LINT_CONFIG_PATH) => Self::LintConfig,
            ("POST", LINT_CONFIG_PATH) => Self::UpdateLintConfig,
            ("GET", LINT_STATE_PATH) => Self::LintState,
            ("POST", RUN_LINT_PATH) => Self::RunLint,
            ("POST", CANCEL_LINT_PATH) => Self::CancelLint,
            ("POST", FIX_LINT_PATH) => Self::FixLint,
            ("POST", REVIEW_LINT_PATH) => Self::ReviewLint,
            ("POST", DELETE_LINT_PATH) => Self::DeleteLint,
            ("POST", DISMISS_LINT_PATH) => Self::DismissLint,
            ("GET", REINDEX_PATH) => Self::ReindexState,
            ("POST", REINDEX_PATH) => Self::StartReindex,
            ("GET", GRAPH_INSIGHTS_PATH) => Self::GraphInsights,
            ("POST", DISMISS_GRAPH_INSIGHT_PATH) => Self::DismissGraphInsight,
            ("POST", GRAPH_INSIGHT_RESEARCH_PATH) => Self::GraphInsightResearchInput,
            _ => return None,
        })
    }

    const fn scope(self) -> &'static str {
        match self {
            Self::StartResearch
            | Self::RerunResearch
            | Self::RemoveResearchTask
            | Self::UpdateSearchConfig
            | Self::TestSearchProvider
            | Self::CreateProject
            | Self::OpenProject
            | Self::WriteFile
            | Self::RescanSources
            | Self::RefreshSources
            | Self::ImportSource
            | Self::ImportFolder
            | Self::ApplyGeneratedPages
            | Self::DeleteSource
            | Self::CallResult
            | Self::UpdateSourceWatchConfig
            | Self::CancelSourceTask
            | Self::RetrySourceTask
            | Self::PauseSourceTask
            | Self::ResumeSourceTask
            | Self::ReorderSourceTask
            | Self::ResolveReview
            | Self::DismissReview
            | Self::ClearResolvedReviews
            | Self::EmbedPage
            | Self::RestoreHistory
            | Self::UpdateHistoryConfig
            | Self::ClearHistory
            | Self::ExportArchive
            | Self::ImportArchive
            | Self::RebuildIndex
            | Self::AskQuestion
            | Self::CancelQuestion
            | Self::SaveQuestion
            | Self::UpdateLintConfig
            | Self::RunLint
            | Self::CancelLint
            | Self::FixLint
            | Self::ReviewLint
            | Self::DeleteLint
            | Self::DismissLint
            | Self::StartReindex
            | Self::DismissGraphInsight
            | Self::GraphInsightResearchInput => AUTHORIZATION_SCOPE_WRITE,
            Self::ResearchTasks
            | Self::SearchConfig
            | Self::Status
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
            | Self::RetrieveContext
            | Self::HistoryList
            | Self::HistoryStats
            | Self::HistoryConfig
            | Self::QuestionTask
            | Self::LintConfig
            | Self::LintState
            | Self::ReindexState
            | Self::GraphInsights => AUTHORIZATION_SCOPE_READ,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CallResultInput {
    call_id: platform::call::CallId,
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
        .is_ok_and(|decision| {
            !matches!(
                endpoint,
                APPLY_GENERATED_PAGES_PATH
                    | DELETE_SOURCE_PATH
                    | CALL_RESULT_PATH
                    | EXPORT_ARCHIVE_PATH
                    | IMPORT_ARCHIVE_PATH
            ) || decision.principal() == "electron-main-local"
        })
}

async fn selected_project_id(
    wiki: &WikiHandle,
    project_id: Option<String>,
) -> Result<String, WikiFailure> {
    match project_id {
        Some(id) => Ok(id),
        None => wiki
            .projects()
            .await?
            .current_project_id()
            .map(str::to_owned)
            .ok_or(WikiFailure::CurrentProjectUnset),
    }
}

fn decode_project_body<T: for<'de> Deserialize<'de>>(
    request: &Request,
) -> Option<(Option<String>, T)> {
    let mut body: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&request.body).ok()?;
    let project_id = match body.remove("projectId") {
        Some(serde_json::Value::String(id)) => Some(id),
        None | Some(serde_json::Value::Null) => None,
        _ => return None,
    };
    Some((
        project_id,
        serde_json::from_value(serde_json::Value::Object(body)).ok()?,
    ))
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

fn admit(result: Result<platform::call::CallReceipt, WikiFailure>) -> Response {
    match result {
        Ok(receipt) => Response::json(202, json!(receipt)),
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
        SEARCH_CONFIG_PATH
            | SEARCH_PROVIDER_TEST_PATH
            | RESEARCH_TASKS_PATH
            | RESEARCH_START_PATH
            | RESEARCH_RERUN_PATH
            | RESEARCH_REMOVE_PATH
            | STATUS_PATH
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
            | CALL_RESULT_PATH
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
            | HISTORY_LIST_PATH
            | HISTORY_RESTORE_PATH
            | HISTORY_STATS_PATH
            | HISTORY_CONFIG_PATH
            | HISTORY_CLEAR_PATH
            | EXPORT_ARCHIVE_PATH
            | IMPORT_ARCHIVE_PATH
            | REBUILD_INDEX_PATH
            | ASK_QUESTION_PATH
            | QUESTION_TASK_PATH
            | CANCEL_QUESTION_PATH
            | SAVE_QUESTION_PATH
            | LINT_CONFIG_PATH
            | LINT_STATE_PATH
            | RUN_LINT_PATH
            | CANCEL_LINT_PATH
            | FIX_LINT_PATH
            | REVIEW_LINT_PATH
            | DELETE_LINT_PATH
            | DISMISS_LINT_PATH
            | REINDEX_PATH
            | GRAPH_INSIGHTS_PATH
            | DISMISS_GRAPH_INSIGHT_PATH
            | GRAPH_INSIGHT_RESEARCH_PATH
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
