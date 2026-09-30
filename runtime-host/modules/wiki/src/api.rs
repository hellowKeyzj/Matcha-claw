use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use crate::call::{
    self, CallReply, CallWorkflows, WikiCallDetail, WikiCallOperation, WikiCallTaskState,
    WikiSourceCallCounts, WikiWorkflowSummary,
};
use platform::call::{CallContext, CallReceipt, CallRecorder};

use foundation::execution::{OwnerRuntimeHandle, TaskHandle};
use tokio::sync::oneshot;

use crate::{
    application::commands::{WikiCommand, WikiQuery},
    domain::{
        WikiApplyGeneratedPagesInput, WikiApplyGeneratedPagesReceipt, WikiCancelSourceTaskInput,
        WikiCreateProjectInput, WikiDeleteSourceInput, WikiDeleteSourceReceipt, WikiFailure,
        WikiFilesInput, WikiFilesReceipt, WikiGraphReceipt, WikiImportFolderInput,
        WikiImportFolderReceipt, WikiImportSourceInput, WikiImportSourceReceipt,
        WikiOpenProjectInput, WikiPathSelector, WikiProjectSelector, WikiProjectTemplatesReceipt,
        WikiProjectsReceipt, WikiReadBinaryInput, WikiReadBinaryReceipt, WikiReadInput,
        WikiReadReceipt, WikiRefreshSourcesReceipt, WikiReorderSourceTaskInput,
        WikiRetrieveContextInput, WikiReviewClearResolvedInput, WikiReviewDismissInput,
        WikiReviewResolveInput, WikiReviewsReceipt, WikiSearchInput, WikiSearchReceipt,
        WikiSourceFilesReceipt, WikiSourceTaskActionInput, WikiSourceTasksReceipt,
        WikiSourceWatchConfigInput, WikiSourceWatchConfigReceipt, WikiStatusReceipt,
        WikiWriteInput, WikiWriteReceipt,
    },
};

#[derive(Clone)]
pub struct WikiHandle {
    owner: OwnerRuntimeHandle<WikiCommand, WikiQuery>,
    recorder: Arc<OnceLock<CallRecorder>>,
    audit: bool,
    workflows: Arc<CallWorkflows>,
    results: Arc<crate::call_result::WikiCallResults>,
    shutdown: Arc<OnceLock<TaskHandle>>,
}

impl WikiHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<WikiCommand, WikiQuery>) -> Self {
        Self {
            owner,
            recorder: Arc::new(OnceLock::new()),
            audit: true,
            workflows: Arc::new(CallWorkflows::default()),
            results: Arc::new(crate::call_result::WikiCallResults::default()),
            shutdown: Arc::new(OnceLock::new()),
        }
    }

    pub(crate) fn with_call_recorder(self, recorder: CallRecorder) -> Self {
        let _ = self.recorder.set(recorder);
        self
    }

    pub(crate) fn with_shutdown(self, shutdown: TaskHandle) -> Self {
        let _ = self.shutdown.set(shutdown);
        self
    }

    pub async fn shutdown_call_workflows(&self) {
        if let Some(shutdown) = self.shutdown.get() {
            shutdown.cancel();
        }
        self.drain_call_workflows().await;
    }

    pub(crate) async fn drain_call_workflows(&self) {
        self.workflows.shutdown().await;
    }

    pub async fn status(&self) -> Result<WikiStatusReceipt, WikiFailure> {
        self.request_query(Some("status"), |reply| WikiQuery::Status { reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn projects(&self) -> Result<WikiProjectsReceipt, WikiFailure> {
        self.request_query(Some("projects"), |reply| WikiQuery::Projects { reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn project_templates(&self) -> Result<WikiProjectTemplatesReceipt, WikiFailure> {
        self.request_query(Some("project-templates"), |reply| {
            WikiQuery::ProjectTemplates { reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn create_project(
        &self,
        input: WikiCreateProjectInput,
    ) -> Result<WikiProjectsReceipt, WikiFailure> {
        self.request_command(Some("project.create"), |reply| WikiCommand::CreateProject {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn open_project(
        &self,
        input: WikiOpenProjectInput,
    ) -> Result<WikiProjectsReceipt, WikiFailure> {
        self.request_command(Some("project.open"), |reply| WikiCommand::OpenProject {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn set_current_project(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiProjectsReceipt, WikiFailure> {
        self.request_command(Some("project.current"), |reply| {
            WikiCommand::SetCurrentProject { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn source_watch_config(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiSourceWatchConfigReceipt, WikiFailure> {
        self.request_query(Some("source-watch-config.read"), |reply| {
            WikiQuery::SourceWatchConfig { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn update_source_watch_config(
        &self,
        input: WikiSourceWatchConfigInput,
    ) -> Result<WikiSourceWatchConfigReceipt, WikiFailure> {
        self.request_command(Some("source-watch-config.update"), |reply| {
            WikiCommand::UpdateSourceWatchConfig { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn files(&self, input: WikiFilesInput) -> Result<WikiFilesReceipt, WikiFailure> {
        self.request_query(Some("files"), |reply| WikiQuery::Files { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn read(&self, input: WikiReadInput) -> Result<WikiReadReceipt, WikiFailure> {
        self.request_query(Some("read-file"), |reply| WikiQuery::ReadFile {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn read_binary(
        &self,
        input: WikiReadBinaryInput,
    ) -> Result<WikiReadBinaryReceipt, WikiFailure> {
        self.request_query(Some("read-binary-file"), |reply| {
            WikiQuery::ReadBinaryFile { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn read_source_preview(
        &self,
        input: WikiReadInput,
    ) -> Result<WikiReadReceipt, WikiFailure> {
        self.request_query(Some("read-source-preview"), |reply| {
            WikiQuery::ReadSourcePreview { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn write(&self, input: WikiWriteInput) -> Result<WikiWriteReceipt, WikiFailure> {
        self.request_command(Some("write-file"), |reply| WikiCommand::WriteFile {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn search(&self, input: WikiSearchInput) -> Result<WikiSearchReceipt, WikiFailure> {
        self.request_query(Some("search"), |reply| WikiQuery::Search { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn import_source(
        &self,
        input: WikiImportSourceInput,
    ) -> Result<WikiImportSourceReceipt, WikiFailure> {
        let owner = self.unrecorded();
        self.workflows
            .run(self.recorder(), "import-source", async move {
                owner.import_source_inline(input).await
            })
            .await
    }

    pub(crate) async fn admit_import_source(
        &self,
        mut input: WikiImportSourceInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::ImportSource;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let owner = self.unrecorded();
        self.workflows
            .admit(
                call,
                operation,
                async move { owner.import_source_inline(input).await },
                |receipt| {
                    WikiWorkflowSummary::Sources(WikiSourceCallCounts::import_source(receipt))
                },
            )
            .await
    }

    async fn import_source_inline(
        &self,
        input: WikiImportSourceInput,
    ) -> Result<WikiImportSourceReceipt, WikiFailure> {
        let staged = self
            .request_command(None, |reply| WikiCommand::StageImportSource {
                input,
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        self.import_staged_source(staged).await
    }

    async fn import_staged_source(
        &self,
        staged: crate::application::commands::WikiStagedImportSource,
    ) -> Result<WikiImportSourceReceipt, WikiFailure> {
        let parsed = match self
            .request_command(None, |reply| WikiCommand::ParseImportSource {
                input: staged.clone(),
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
        {
            Ok(parsed) => parsed,
            Err(error) => {
                if !error.is_cancelled() {
                    self.mark_source_task_failed(&staged, &error).await;
                }
                return Err(error);
            }
        };
        match self
            .request_command(None, |reply| WikiCommand::CommitImportSource {
                input: parsed,
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
        {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                if !error.is_cancelled() {
                    self.mark_source_task_failed(&staged, &error).await;
                }
                Err(error)
            }
        }
    }

    async fn mark_source_task_failed(
        &self,
        staged: &crate::application::commands::WikiStagedImportSource,
        error: &WikiFailure,
    ) {
        let _ = self
            .request_command(None, |reply| WikiCommand::MarkSourceTaskFailed {
                project_id: staged.project_id.clone(),
                source_relative_path: staged.source_relative_path.clone(),
                error: format!("{error:?}"),
                reply,
            })
            .await;
    }

    pub async fn import_folder(
        &self,
        input: WikiImportFolderInput,
    ) -> Result<WikiImportFolderReceipt, WikiFailure> {
        let owner = self.unrecorded();
        self.workflows
            .run(self.recorder(), "import-folder", async move {
                owner.import_folder_inline(input).await
            })
            .await
    }

    pub(crate) async fn admit_import_folder(
        &self,
        mut input: WikiImportFolderInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::ImportFolder;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let owner = self.unrecorded();
        self.workflows
            .admit(
                call,
                operation,
                async move { owner.import_folder_inline(input).await },
                |receipt| {
                    WikiWorkflowSummary::Sources(WikiSourceCallCounts::import_folder(receipt))
                },
            )
            .await
    }

    async fn import_folder_inline(
        &self,
        input: WikiImportFolderInput,
    ) -> Result<WikiImportFolderReceipt, WikiFailure> {
        let plan = self
            .request_command(None, |reply| WikiCommand::StageImportFolder {
                input,
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        let mut imported = Vec::new();
        let mut skipped = plan.skipped;
        for staged in plan.imports {
            match self.import_staged_source(staged.clone()).await {
                Ok(receipt) => imported.push(receipt),
                Err(error) => {
                    skipped.push(crate::domain::WikiSourceSkip::new(
                        staged.source_relative_path,
                        format!("{error:?}"),
                    ));
                }
            }
        }
        Ok(WikiImportFolderReceipt::new(imported, skipped))
    }

    pub async fn refresh_sources(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiRefreshSourcesReceipt, WikiFailure> {
        let owner = self.unrecorded();
        self.workflows
            .run(self.recorder(), "refresh-sources", async move {
                owner.refresh_sources_inline(input).await
            })
            .await
    }

    pub(crate) async fn admit_refresh_sources(
        &self,
        mut input: WikiProjectSelector,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::RefreshSources;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let owner = self.unrecorded();
        self.workflows
            .admit(
                call,
                operation,
                async move { owner.refresh_sources_inline(input).await },
                |receipt| {
                    WikiWorkflowSummary::Sources(WikiSourceCallCounts::refresh_sources(receipt))
                },
            )
            .await
    }

    async fn refresh_sources_inline(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiRefreshSourcesReceipt, WikiFailure> {
        let plan = self
            .request_command(None, |reply| WikiCommand::StageRefreshSources {
                input,
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        self.apply_refresh_plan(plan, true).await
    }

    pub(crate) async fn refresh_source_paths(
        &self,
        project_id: String,
        paths: Vec<PathBuf>,
        auto_ingest: bool,
    ) -> Result<WikiRefreshSourcesReceipt, WikiFailure> {
        let owner = self.unrecorded();
        self.workflows
            .run(self.recorder(), "refresh-source-paths", async move {
                owner
                    .refresh_source_paths_inline(project_id, paths, auto_ingest)
                    .await
            })
            .await
    }

    async fn refresh_source_paths_inline(
        &self,
        project_id: String,
        paths: Vec<PathBuf>,
        auto_ingest: bool,
    ) -> Result<WikiRefreshSourcesReceipt, WikiFailure> {
        let plan = self
            .request_command(None, |reply| WikiCommand::StageRefreshSourcePaths {
                project_id,
                paths,
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        self.apply_refresh_plan(plan, auto_ingest).await
    }

    async fn run_source_task_plan(
        &self,
        plan: crate::application::commands::WikiSourceTaskRunPlan,
    ) -> Result<WikiWorkflowSummary, WikiFailure> {
        let failure = match plan.staged {
            Some(staged) => self.import_staged_source(staged).await.err(),
            None => None,
        };
        let tasks = self
            .source_tasks(WikiProjectSelector {
                project_id: Some(plan.project_id.clone()),
            })
            .await;
        let tasks = match tasks {
            Ok(tasks) => tasks,
            Err(error) => {
                return Ok(WikiWorkflowSummary::SourceTask {
                    state: None,
                    failure: failure.or(Some(error)),
                });
            }
        };
        // Generation can replace the task id; the plan's project/source is the lifecycle identity.
        let state = tasks
            .tasks()
            .iter()
            .rev()
            .find(|task| {
                task.project_id() == plan.project_id
                    && task.source_path() == plan.source_relative_path
            })
            .map_or(WikiCallTaskState::Missing, |task| {
                if task.is_paused() {
                    return WikiCallTaskState::Paused;
                }
                match task.status() {
                    crate::WikiSourceTaskStatus::Pending => WikiCallTaskState::Pending,
                    crate::WikiSourceTaskStatus::Running => WikiCallTaskState::Running,
                    crate::WikiSourceTaskStatus::Done => WikiCallTaskState::Done,
                    crate::WikiSourceTaskStatus::Failed => WikiCallTaskState::Failed,
                    crate::WikiSourceTaskStatus::Cancelled => WikiCallTaskState::Cancelled,
                }
            });
        Ok(WikiWorkflowSummary::SourceTask {
            state: Some(state),
            failure,
        })
    }

    async fn apply_refresh_plan(
        &self,
        plan: crate::application::commands::WikiRefreshSourcesPlan,
        auto_ingest: bool,
    ) -> Result<WikiRefreshSourcesReceipt, WikiFailure> {
        let mut moved = Vec::new();
        for (old_source_relative_path, new_source_relative_path) in plan.moves {
            moved.push(
                self.request_command(None, |reply| WikiCommand::MigrateSourcePath {
                    project_id: plan.project_id.clone(),
                    old_source_relative_path,
                    new_source_relative_path,
                    reply,
                })
                .await
                .unwrap_or(Err(WikiFailure::OwnerUnavailable))?,
            );
        }
        let mut deleted = Vec::new();
        for source_path in plan.deletions {
            deleted.push(
                self.delete_source(WikiDeleteSourceInput {
                    project_id: Some(plan.project_id.clone()),
                    source_path,
                    file_already_deleted: true,
                })
                .await?,
            );
        }
        if !plan.wiki_deletions.is_empty() {
            self.request_command(None, |reply| WikiCommand::CleanupDeletedWikiPages {
                project_id: plan.project_id.clone(),
                paths: plan.wiki_deletions,
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        }
        let mut imported = Vec::new();
        let mut skipped = plan.skipped;
        if auto_ingest {
            for staged in plan.imports {
                match self.import_staged_source(staged.clone()).await {
                    Ok(receipt) => imported.push(receipt),
                    Err(error) => {
                        skipped.push(crate::domain::WikiSourceSkip::new(
                            staged.source_relative_path,
                            format!("{error:?}"),
                        ));
                    }
                }
            }
        }
        Ok(WikiRefreshSourcesReceipt::new(
            imported, deleted, moved, skipped,
        ))
    }

    pub(crate) async fn admit_delete_source(
        &self,
        mut input: WikiDeleteSourceInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::DeleteSource;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, true, |reply| WikiCommand::DeleteSource {
            input,
            reply,
        })
        .await
    }

    pub(crate) async fn admit_apply_generated_pages(
        &self,
        mut input: WikiApplyGeneratedPagesInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::ApplyGeneratedPages;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, true, |reply| {
            WikiCommand::ApplyGeneratedPages { input, reply }
        })
        .await
    }

    pub(crate) fn call_result(
        &self,
        call_id: &platform::call::CallId,
    ) -> Result<crate::call_result::WikiCallResultReceipt, WikiFailure> {
        self.results.get(call_id)
    }

    pub async fn delete_source(
        &self,
        input: WikiDeleteSourceInput,
    ) -> Result<WikiDeleteSourceReceipt, WikiFailure> {
        self.request_command(Some("delete-source"), |reply| WikiCommand::DeleteSource {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn apply_generated_pages(
        &self,
        input: WikiApplyGeneratedPagesInput,
    ) -> Result<WikiApplyGeneratedPagesReceipt, WikiFailure> {
        self.request_command(Some("apply-generated-pages"), |reply| {
            WikiCommand::ApplyGeneratedPages { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn reviews(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiReviewsReceipt, WikiFailure> {
        self.request_query(Some("reviews"), |reply| WikiQuery::Reviews { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn resolve_review(
        &self,
        input: WikiReviewResolveInput,
    ) -> Result<WikiReviewsReceipt, WikiFailure> {
        self.request_command(Some("review.resolve"), |reply| WikiCommand::ResolveReview {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn dismiss_review(
        &self,
        input: WikiReviewDismissInput,
    ) -> Result<WikiReviewsReceipt, WikiFailure> {
        self.request_command(Some("review.dismiss"), |reply| WikiCommand::DismissReview {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn clear_resolved_reviews(
        &self,
        input: WikiReviewClearResolvedInput,
    ) -> Result<WikiReviewsReceipt, WikiFailure> {
        self.request_command(Some("reviews.clear-resolved"), |reply| {
            WikiCommand::ClearResolvedReviews { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn source_tasks(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.request_query(Some("source-tasks"), |reply| WikiQuery::SourceTasks {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn cancel_source_task(
        &self,
        input: WikiCancelSourceTaskInput,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.request_command(Some("source-task.cancel"), |reply| {
            WikiCommand::CancelSourceTask { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_retry_source_task(
        &self,
        mut input: WikiSourceTaskActionInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::RetrySourceTask;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let owner = self.unrecorded();
        self.workflows
            .admit(
                call,
                operation,
                async move { owner.retry_source_task_inline(input).await },
                Clone::clone,
            )
            .await
    }

    async fn retry_source_task_inline(
        &self,
        input: WikiSourceTaskActionInput,
    ) -> Result<WikiWorkflowSummary, WikiFailure> {
        let plan = self
            .request_command(None, |reply| WikiCommand::RetrySourceTask { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        self.run_source_task_plan(plan).await
    }

    pub(crate) async fn pause_source_task(
        &self,
        input: WikiSourceTaskActionInput,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.request_command(Some("source-task.pause"), |reply| {
            WikiCommand::PauseSourceTask { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_resume_source_task(
        &self,
        mut input: WikiSourceTaskActionInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::ResumeSourceTask;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let owner = self.unrecorded();
        self.workflows
            .admit(
                call,
                operation,
                async move { owner.resume_source_task_inline(input).await },
                Clone::clone,
            )
            .await
    }

    async fn resume_source_task_inline(
        &self,
        input: WikiSourceTaskActionInput,
    ) -> Result<WikiWorkflowSummary, WikiFailure> {
        let plan = self
            .request_command(None, |reply| WikiCommand::ResumeSourceTask { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        self.run_source_task_plan(plan).await
    }

    pub(crate) async fn reorder_source_task(
        &self,
        input: WikiReorderSourceTaskInput,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.request_command(Some("source-task.reorder"), |reply| {
            WikiCommand::ReorderSourceTask { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn source_files(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiSourceFilesReceipt, WikiFailure> {
        self.request_query(Some("source-files"), |reply| WikiQuery::SourceFiles {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn graph(&self, input: WikiProjectSelector) -> Result<WikiGraphReceipt, WikiFailure> {
        self.request_query(Some("graph"), |reply| WikiQuery::Graph { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn rescan(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiStatusReceipt, WikiFailure> {
        self.request_command(Some("rescan-sources"), |reply| WikiCommand::Rescan {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_rescan(
        &self,
        mut input: WikiProjectSelector,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::RescanSources;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, false, |reply| WikiCommand::Rescan {
            input,
            reply,
        })
        .await
    }

    async fn admit_command<T>(
        &self,
        call: CallContext<WikiCallDetail>,
        operation: WikiCallOperation,
        retain_result: bool,
        command: impl FnOnce(CallReply<T>) -> WikiCommand,
    ) -> Result<CallReceipt, WikiFailure> {
        let (sender, _response) = oneshot::channel();
        let mut reply = CallReply::new(sender);
        reply.call = Some(call.clone());
        reply.operation = Some(operation);
        let acceptance = Arc::new(tokio::sync::OnceCell::new());
        reply.acceptance = Some(acceptance.clone());
        if retain_result {
            match self.results.reserve(call.id()) {
                Ok(reservation) => reply.result = Some(reservation),
                Err(error) => {
                    call::reject_admission(
                        &call,
                        operation,
                        foundation::execution::OwnerRuntimeSendError::Full,
                    )
                    .await;
                    return Err(error);
                }
            }
        }
        if let Err(error) = self.owner.try_send_command(command(reply)) {
            call::reject_admission(&call, operation, error).await;
            return Err(WikiFailure::OwnerUnavailable);
        }
        call::accepted(&call, &acceptance).await
    }

    pub(crate) async fn admit_embed_page(
        &self,
        mut input: WikiPathSelector,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::EmbedPage;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, false, |reply| WikiCommand::EmbedPage {
            input,
            reply,
        })
        .await
    }

    pub async fn embed_page(&self, input: WikiPathSelector) -> Result<(), WikiFailure> {
        self.request_command(Some("embed-page"), |reply| WikiCommand::EmbedPage {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn retrieve_context(
        &self,
        input: WikiRetrieveContextInput,
    ) -> Result<WikiSearchReceipt, WikiFailure> {
        self.request_query(Some("retrieve-context"), |reply| {
            WikiQuery::RetrieveContext { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    fn unrecorded(&self) -> Self {
        Self {
            owner: self.owner.clone(),
            recorder: self.recorder.clone(),
            audit: false,
            workflows: self.workflows.clone(),
            results: self.results.clone(),
            shutdown: self.shutdown.clone(),
        }
    }

    fn recorder(&self) -> Option<&CallRecorder> {
        self.audit.then(|| self.recorder.get()).flatten()
    }

    async fn begin_admission(
        &self,
        operation: WikiCallOperation,
        project_id: &mut Option<String>,
    ) -> Result<CallContext<WikiCallDetail>, WikiFailure> {
        let call = self
            .recorder()
            .ok_or(WikiFailure::OwnerUnavailable)?
            .begin(operation.command(), &WikiCallDetail::new(operation))
            .await
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        if let Err(error) = self.resolve_current_project(project_id).await {
            call::finish_detail(Some(&call), Some(&error), Some(operation)).await;
            return Err(error);
        }
        Ok(call)
    }

    async fn resolve_current_project(
        &self,
        project_id: &mut Option<String>,
    ) -> Result<(), WikiFailure> {
        if project_id.is_some() {
            return Ok(());
        }
        *project_id = Some(
            self.unrecorded()
                .projects()
                .await?
                .current_project_id()
                .ok_or(WikiFailure::CurrentProjectUnset)?
                .to_owned(),
        );
        Ok(())
    }

    async fn request_command<T>(
        &self,
        operation: Option<&'static str>,
        command: impl FnOnce(CallReply<T>) -> WikiCommand,
    ) -> Result<Result<T, WikiFailure>, ()> {
        let (reply, response) = oneshot::channel();
        let call = match operation {
            Some(operation) => call::begin(self.recorder(), operation)
                .await
                .map_err(|_| ())?,
            None => None,
        };
        let mut command = command(CallReply::new(reply));
        command.set_call(call.clone());
        if let Some(project_id) = command.project_id_mut() {
            if let Err(error) = self.resolve_current_project(project_id).await {
                call::finish(call.as_ref(), Some(&error)).await;
                return Ok(Err(error));
            }
        }
        if self.owner.send_command(command).await.is_err() {
            call::finish(call.as_ref(), Some(&WikiFailure::OwnerUnavailable)).await;
            return Err(());
        }
        response.await.map_err(|_| ())
    }

    async fn request_query<T>(
        &self,
        operation: Option<&'static str>,
        query: impl FnOnce(CallReply<T>) -> WikiQuery,
    ) -> Result<Result<T, WikiFailure>, ()> {
        let (reply, response) = oneshot::channel();
        let call = match operation {
            Some(operation) => call::begin(self.recorder(), operation)
                .await
                .map_err(|_| ())?,
            None => None,
        };
        let mut query = query(CallReply::new(reply));
        query.set_call(call.clone());
        if self.owner.send_query(query).await.is_err() {
            call::finish(call.as_ref(), Some(&WikiFailure::OwnerUnavailable)).await;
            return Err(());
        }
        response.await.map_err(|_| ())
    }
}
