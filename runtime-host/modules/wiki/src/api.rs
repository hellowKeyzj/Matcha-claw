use std::path::PathBuf;

use foundation::execution::OwnerRuntimeHandle;
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
}

impl WikiHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<WikiCommand, WikiQuery>) -> Self {
        Self { owner }
    }

    pub async fn status(&self) -> Result<WikiStatusReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::Status { reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn projects(&self) -> Result<WikiProjectsReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::Projects { reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn project_templates(&self) -> Result<WikiProjectTemplatesReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::ProjectTemplates { reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn create_project(
        &self,
        input: WikiCreateProjectInput,
    ) -> Result<WikiProjectsReceipt, WikiFailure> {
        self.request_command(|reply| WikiCommand::CreateProject { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn open_project(
        &self,
        input: WikiOpenProjectInput,
    ) -> Result<WikiProjectsReceipt, WikiFailure> {
        self.request_command(|reply| WikiCommand::OpenProject { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn set_current_project(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiProjectsReceipt, WikiFailure> {
        self.request_command(|reply| WikiCommand::SetCurrentProject { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn source_watch_config(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiSourceWatchConfigReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::SourceWatchConfig { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn update_source_watch_config(
        &self,
        mut input: WikiSourceWatchConfigInput,
    ) -> Result<WikiSourceWatchConfigReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::UpdateSourceWatchConfig { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn files(&self, input: WikiFilesInput) -> Result<WikiFilesReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::Files { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn read(&self, input: WikiReadInput) -> Result<WikiReadReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::ReadFile { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn read_binary(
        &self,
        input: WikiReadBinaryInput,
    ) -> Result<WikiReadBinaryReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::ReadBinaryFile { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn read_source_preview(
        &self,
        input: WikiReadInput,
    ) -> Result<WikiReadReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::ReadSourcePreview { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn write(&self, mut input: WikiWriteInput) -> Result<WikiWriteReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::WriteFile { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn search(&self, input: WikiSearchInput) -> Result<WikiSearchReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::Search { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn import_source(
        &self,
        mut input: WikiImportSourceInput,
    ) -> Result<WikiImportSourceReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        let staged = self
            .request_command(|reply| WikiCommand::StageImportSource { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        self.import_staged_source(staged).await
    }

    async fn import_staged_source(
        &self,
        staged: crate::application::commands::WikiStagedImportSource,
    ) -> Result<WikiImportSourceReceipt, WikiFailure> {
        let parsed = match self
            .request_command(|reply| WikiCommand::ParseImportSource {
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
            .request_command(|reply| WikiCommand::CommitImportSource {
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
            .request_command(|reply| WikiCommand::MarkSourceTaskFailed {
                project_id: staged.project_id.clone(),
                source_relative_path: staged.source_relative_path.clone(),
                error: format!("{error:?}"),
                reply,
            })
            .await;
    }

    pub async fn import_folder(
        &self,
        mut input: WikiImportFolderInput,
    ) -> Result<WikiImportFolderReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        let plan = self
            .request_command(|reply| WikiCommand::StageImportFolder { input, reply })
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
        mut input: WikiProjectSelector,
    ) -> Result<WikiRefreshSourcesReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        let plan = self
            .request_command(|reply| WikiCommand::StageRefreshSources { input, reply })
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
        let plan = self
            .request_command(|reply| WikiCommand::StageRefreshSourcePaths {
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
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        if let Some(staged) = plan.staged {
            let _ = self.import_staged_source(staged).await;
        }
        self.source_tasks(WikiProjectSelector {
            project_id: Some(plan.project_id),
        })
        .await
    }

    async fn apply_refresh_plan(
        &self,
        plan: crate::application::commands::WikiRefreshSourcesPlan,
        auto_ingest: bool,
    ) -> Result<WikiRefreshSourcesReceipt, WikiFailure> {
        let mut moved = Vec::new();
        for (old_source_relative_path, new_source_relative_path) in plan.moves {
            moved.push(
                self.request_command(|reply| WikiCommand::MigrateSourcePath {
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
            self.request_command(|reply| WikiCommand::CleanupDeletedWikiPages {
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

    pub async fn delete_source(
        &self,
        mut input: WikiDeleteSourceInput,
    ) -> Result<WikiDeleteSourceReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::DeleteSource { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn apply_generated_pages(
        &self,
        mut input: WikiApplyGeneratedPagesInput,
    ) -> Result<WikiApplyGeneratedPagesReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::ApplyGeneratedPages { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn reviews(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiReviewsReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::Reviews { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn resolve_review(
        &self,
        mut input: WikiReviewResolveInput,
    ) -> Result<WikiReviewsReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::ResolveReview { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn dismiss_review(
        &self,
        mut input: WikiReviewDismissInput,
    ) -> Result<WikiReviewsReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::DismissReview { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn clear_resolved_reviews(
        &self,
        mut input: WikiReviewClearResolvedInput,
    ) -> Result<WikiReviewsReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::ClearResolvedReviews { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn source_tasks(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::SourceTasks { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn cancel_source_task(
        &self,
        mut input: WikiCancelSourceTaskInput,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::CancelSourceTask { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn retry_source_task(
        &self,
        mut input: WikiSourceTaskActionInput,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        let plan = self
            .request_command(|reply| WikiCommand::RetrySourceTask { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        self.run_source_task_plan(plan).await
    }

    pub(crate) async fn pause_source_task(
        &self,
        mut input: WikiSourceTaskActionInput,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::PauseSourceTask { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn resume_source_task(
        &self,
        mut input: WikiSourceTaskActionInput,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        let plan = self
            .request_command(|reply| WikiCommand::ResumeSourceTask { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        self.run_source_task_plan(plan).await
    }

    pub(crate) async fn reorder_source_task(
        &self,
        mut input: WikiReorderSourceTaskInput,
    ) -> Result<WikiSourceTasksReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::ReorderSourceTask { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn source_files(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiSourceFilesReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::SourceFiles { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn graph(&self, input: WikiProjectSelector) -> Result<WikiGraphReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::Graph { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn rescan(
        &self,
        mut input: WikiProjectSelector,
    ) -> Result<WikiStatusReceipt, WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::Rescan { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn embed_page(&self, mut input: WikiPathSelector) -> Result<(), WikiFailure> {
        self.resolve_current_project(&mut input.project_id).await?;
        self.request_command(|reply| WikiCommand::EmbedPage { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn retrieve_context(
        &self,
        input: WikiRetrieveContextInput,
    ) -> Result<WikiSearchReceipt, WikiFailure> {
        self.request_query(|reply| WikiQuery::RetrieveContext { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    async fn resolve_current_project(
        &self,
        project_id: &mut Option<String>,
    ) -> Result<(), WikiFailure> {
        if project_id.is_some() {
            return Ok(());
        }
        *project_id = Some(
            self.projects()
                .await?
                .current_project_id()
                .ok_or(WikiFailure::CurrentProjectUnset)?
                .to_owned(),
        );
        Ok(())
    }

    async fn request_command<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> WikiCommand,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(command(reply))
            .await
            .map_err(|_| ())?;
        response.await.map_err(|_| ())
    }

    async fn request_query<T>(
        &self,
        query: impl FnOnce(oneshot::Sender<T>) -> WikiQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner.send_query(query(reply)).await.map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
