use std::path::PathBuf;

use crate::call::{CallReply, WikiCallAcceptance, WikiCallDetail};
use platform::call::CallContext;

use crate::domain::{
    WikiApplyGeneratedPagesInput, WikiApplyGeneratedPagesReceipt,
    WikiCreateProjectInput, WikiDeleteSourceInput, WikiDeleteSourceReceipt, WikiFailure,
    WikiFilesInput, WikiFilesReceipt, WikiGraphReceipt, WikiImportFolderInput,
    WikiImportSourceInput, WikiImportSourceReceipt, WikiOpenProjectInput, WikiPathSelector,
    WikiProjectSelector, WikiProjectTemplatesReceipt, WikiProjectsReceipt, WikiReadBinaryInput,
    WikiReadBinaryReceipt, WikiReadInput, WikiReadReceipt, WikiReorderSourceTaskInput,
    WikiRetrieveContextInput, WikiReviewClearResolvedInput, WikiReviewDismissInput,
    WikiReviewResolveInput, WikiReviewsReceipt, WikiSearchInput, WikiSearchReceipt,
    WikiSourceFilesReceipt, WikiSourceMoveReceipt, WikiSourceSkip, WikiSourceTaskActionInput,
    WikiSourceTaskKind, WikiSourceTasksReceipt, WikiSourceWatchConfigInput,
    WikiSourceWatchConfigReceipt, WikiStatusReceipt, WikiWriteInput, WikiWriteReceipt,
};

pub(crate) enum WikiCommand {
    ApplySelection {
        input: crate::WikiSelectionApplyInput,
        reply: CallReply<crate::WikiSelectionApplyReceipt>,
    },
    BeginSourceWork {
        project_id: String,
        reply: CallReply<crate::sweep::SourceWork>,
    },
    StageReviewSweep {
        project_id: String,
        reply: CallReply<Option<crate::sweep::ReviewSweepPlan>>,
    },
    CompleteReviewSweep {
        plan: crate::sweep::ReviewSweepPlan,
        resolved_ids: Vec<String>,
        reply: CallReply<()>,
    },
    DetectDuplicates {
        plan: crate::dedup::DedupDetectionPlan,
        reply: CallReply<crate::WikiDedupDetection>,
    },
    EnqueueDedup {
        input: crate::WikiDedupMergeInput,
        task_id: String,
        reply: CallReply<crate::WikiDedupTaskInput>,
    },
    PrepareDedup {
        input: crate::WikiDedupTaskInput,
        reply: CallReply<crate::dedup::DedupMergePlan>,
    },
    CompleteDedup {
        plan: crate::dedup::DedupMergePlan,
        reply: CallReply<crate::WikiDedupState>,
    },
    FailDedup {
        input: crate::WikiDedupTaskInput,
        error: WikiFailure,
        reply: CallReply<crate::WikiDedupState>,
    },
    RetryDedup {
        input: crate::WikiDedupTaskInput,
        reply: CallReply<crate::WikiDedupTaskInput>,
    },
    ResumeDedup {
        input: crate::WikiDedupTaskInput,
        reply: CallReply<crate::WikiDedupTaskInput>,
    },
    ExcludeDuplicates {
        input: crate::WikiDedupExcludeInput,
        reply: CallReply<crate::WikiDedupState>,
    },
    CreateMissingPage {
        plan: crate::page_links::MissingPagePlan,
        reply: CallReply<crate::WikiMissingPageReceipt>,
    },
    ReloadProjects {
        reply: CallReply<()>,
    },
    RestoreHistory {
        input: crate::history::WikiRestoreFileHistoryInput,
        reply: CallReply<WikiReadReceipt>,
    },
    UpdateHistoryConfig {
        input: crate::history::WikiFileHistorySettingsInput,
        reply: CallReply<crate::history::WikiFileHistorySettings>,
    },
    ClearHistory {
        input: WikiProjectSelector,
        reply: CallReply<()>,
    },
    ExportArchive {
        input: crate::WikiArchiveExportInput,
        reply: CallReply<()>,
    },
    ImportArchive {
        input: crate::WikiArchiveImportInput,
        reply: CallReply<WikiProjectsReceipt>,
    },
    RebuildIndex {
        input: WikiProjectSelector,
        reply: CallReply<crate::WikiRebuildIndexReceipt>,
    },
    StageQuestion {
        input: crate::WikiQuestionInput,
        cancellation: tokio_util::sync::CancellationToken,
        reply: CallReply<crate::qa::QuestionPlan>,
    },
    CancelQuestion {
        input: crate::WikiQuestionTaskSelector,
        reply: CallReply<crate::WikiQuestionTaskReceipt>,
    },
    SaveQuestion {
        input: crate::WikiQuestionTaskSelector,
        reply: CallReply<crate::WikiQuestionSaveReceipt>,
    },
    StageReindex {
        input: crate::reindex::WikiReindexInput,
        task_id: Option<String>,
        reply: CallReply<crate::reindex::ReindexPlan>,
    },
    StageLint {
        input: crate::lint::WikiLintRunInput,
        task_id: String,
        reply: CallReply<crate::lint::LintRunPlan>,
    },
    BeginLint {
        plan: crate::lint::LintRunPlan,
        reply: CallReply<()>,
    },
    CompleteLint {
        plan: crate::lint::LintRunPlan,
        result: Result<Vec<crate::lint::WikiLintFinding>, WikiFailure>,
        reply: CallReply<crate::lint::WikiLintState>,
    },
    UpdateLintConfig {
        input: crate::lint::WikiLintConfigInput,
        reply: CallReply<crate::lint::WikiLintConfig>,
    },
    LintAction {
        input: crate::lint::WikiLintActionInput,
        action: crate::lint::LintAction,
        reply: CallReply<crate::lint::WikiLintFixReceipt>,
    },
    DismissLint {
        input: crate::lint::WikiLintActionInput,
        reply: CallReply<crate::lint::WikiLintState>,
    },
    DismissGraphInsight {
        input: crate::insights::WikiGraphInsightInput,
        reply: CallReply<crate::insights::WikiGraphInsightsReceipt>,
    },
    CreateProject {
        input: WikiCreateProjectInput,
        reply: CallReply<WikiProjectsReceipt>,
    },
    OpenProject {
        input: WikiOpenProjectInput,
        reply: CallReply<WikiProjectsReceipt>,
    },
    SetCurrentProject {
        input: WikiProjectSelector,
        reply: CallReply<WikiProjectsReceipt>,
    },
    UpdateSourceWatchConfig {
        input: WikiSourceWatchConfigInput,
        reply: CallReply<WikiSourceWatchConfigReceipt>,
    },
    WriteFile {
        input: WikiWriteInput,
        reply: CallReply<WikiWriteReceipt>,
    },
    StageImportSource {
        input: WikiImportSourceInput,
        reply: CallReply<WikiStagedImportSource>,
    },
    ParseImportSource {
        input: WikiStagedImportSource,
        reply: CallReply<WikiParsedImportSource>,
    },
    CommitImportSource {
        input: WikiParsedImportSource,
        reply: CallReply<WikiImportSourceReceipt>,
    },
    StageImportFolder {
        input: WikiImportFolderInput,
        reply: CallReply<WikiImportFolderPlan>,
    },
    StageRefreshSources {
        input: WikiProjectSelector,
        reply: CallReply<WikiRefreshSourcesPlan>,
    },
    StageRefreshSourcePaths {
        project_id: String,
        paths: Vec<PathBuf>,
        auto_ingest: bool,
        reply: CallReply<WikiRefreshSourcesPlan>,
    },
    CleanupDeletedWikiPages {
        project_id: String,
        paths: Vec<String>,
        reply: CallReply<()>,
    },
    DeletePage {
        input: crate::WikiDeletePageInput,
        reply: CallReply<crate::WikiDeletePageReceipt>,
    },
    DeleteSource {
        input: WikiDeleteSourceInput,
        reply: CallReply<WikiDeleteSourceReceipt>,
    },
    MigrateSourcePath {
        project_id: String,
        old_source_relative_path: String,
        new_source_relative_path: String,
        reply: CallReply<WikiSourceMoveReceipt>,
    },
    ApplyGeneratedPages {
        input: WikiApplyGeneratedPagesInput,
        reply: CallReply<WikiApplyGeneratedPagesReceipt>,
    },
    ResolveReview {
        input: WikiReviewResolveInput,
        reply: CallReply<WikiReviewsReceipt>,
    },
    DismissReview {
        input: WikiReviewDismissInput,
        reply: CallReply<WikiReviewsReceipt>,
    },
    ClearResolvedReviews {
        input: WikiReviewClearResolvedInput,
        reply: CallReply<WikiReviewsReceipt>,
    },
    RetrySourceTask {
        input: WikiSourceTaskActionInput,
        reply: CallReply<WikiSourceTaskRunPlan>,
    },
    PauseSourceTask {
        input: WikiSourceTaskActionInput,
        reply: CallReply<WikiSourceTasksReceipt>,
    },
    ResumeSourceTask {
        input: WikiSourceTaskActionInput,
        reply: CallReply<WikiSourceTaskRunPlan>,
    },
    ReorderSourceTask {
        input: WikiReorderSourceTaskInput,
        reply: CallReply<WikiSourceTasksReceipt>,
    },
    Rescan {
        input: WikiProjectSelector,
        reply: CallReply<WikiStatusReceipt>,
    },
    UpdateSearchConfig {
        project_id: Option<String>,
        input: crate::search_config::SearchConfigUpdate,
        reply: CallReply<crate::search_config::SearchConfig>,
    },
    EmbedPage {
        input: WikiPathSelector,
        reply: CallReply<()>,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct WikiStagedImportSource {
    pub task_id: String,
    pub execution: Option<std::sync::Arc<crate::owner::source_execution::SourceExecution>>,
    pub project_id: String,
    pub project_root: PathBuf,
    pub import_id: String,
    pub source_path: PathBuf,
    pub source_relative_path: String,
    pub source_identity: String,
    pub page_relative_path: String,
    pub task_kind: WikiSourceTaskKind,
}

#[derive(Clone, Debug)]
pub(crate) struct WikiParsedImportSource {
    pub staged: WikiStagedImportSource,
    pub text: String,
    pub images: Vec<WikiParsedImportImage>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WikiParsedImportImage {
    pub index: u32,
    pub mime_type: String,
    pub page: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub rel_path: Option<String>,
    pub data_base64: String,
    pub sha256: String,
}

pub(crate) struct WikiImportFolderPlan {
    pub imports: Vec<WikiStagedImportSource>,
    pub skipped: Vec<WikiSourceSkip>,
}

pub(crate) struct WikiRefreshSourcesPlan {
    pub project_id: String,
    pub imports: Vec<WikiStagedImportSource>,
    pub deletions: Vec<String>,
    pub wiki_deletions: Vec<String>,
    pub moves: Vec<(String, String)>,
    pub skipped: Vec<WikiSourceSkip>,
}

pub(crate) struct WikiSourceTaskRunPlan {
    pub task_id: Option<String>,
    pub project_id: String,
    pub source_relative_path: String,
    pub staged: Option<WikiStagedImportSource>,
}

pub(crate) enum WikiQuery {
    StageSelection {
        input: crate::WikiSelectionInput,
        reply: CallReply<crate::selection::SelectionPlan>,
    },
    SelectionTask {
        input: crate::WikiSelectionTaskInput,
        reply: CallReply<crate::WikiSelectionTask>,
    },
    CancelSelection {
        input: crate::WikiSelectionTaskInput,
        reply: CallReply<crate::WikiSelectionTask>,
    },
    StageDedupDetection {
        input: crate::WikiDedupDetectInput,
        reply: CallReply<crate::dedup::DedupDetectionPlan>,
    },
    DedupState {
        input: WikiProjectSelector,
        reply: CallReply<crate::WikiDedupState>,
    },
    CancelDedup {
        input: crate::WikiDedupTaskInput,
        reply: CallReply<crate::WikiDedupState>,
    },
    PageLinks {
        input: WikiPathSelector,
        reply: CallReply<crate::WikiPageLinks>,
    },
    StageMissingPage {
        input: crate::WikiMissingPageInput,
        reply: CallReply<crate::page_links::MissingPagePlan>,
    },
    CancelMissingPage {
        input: crate::WikiMissingPageCancelInput,
        reply: CallReply<bool>,
    },
    HistoryList {
        input: crate::history::WikiFileHistoryInput,
        reply: CallReply<crate::history::WikiFileHistoryReceipt>,
    },
    HistoryConfig {
        input: WikiProjectSelector,
        reply: CallReply<crate::history::WikiFileHistorySettings>,
    },
    HistoryStats {
        input: WikiProjectSelector,
        reply: CallReply<crate::history::WikiFileHistoryStats>,
    },
    QuestionTask {
        input: crate::WikiQuestionTaskSelector,
        reply: CallReply<crate::WikiQuestionTaskReceipt>,
    },
    ReindexState {
        input: WikiProjectSelector,
        reply: CallReply<crate::reindex::WikiReindexState>,
    },
    LintConfig {
        input: WikiProjectSelector,
        reply: CallReply<crate::lint::WikiLintConfig>,
    },
    LintState {
        input: WikiProjectSelector,
        reply: CallReply<crate::lint::WikiLintState>,
    },
    CancelLint {
        input: crate::lint::WikiLintCancelInput,
        reply: CallReply<crate::lint::WikiLintState>,
    },
    GraphInsights {
        input: WikiProjectSelector,
        reply: CallReply<crate::insights::WikiGraphInsightsReceipt>,
    },
    Status {
        reply: CallReply<WikiStatusReceipt>,
    },
    Projects {
        reply: CallReply<WikiProjectsReceipt>,
    },
    ProjectTemplates {
        reply: CallReply<WikiProjectTemplatesReceipt>,
    },
    Files {
        input: WikiFilesInput,
        reply: CallReply<WikiFilesReceipt>,
    },
    ReadFile {
        input: WikiReadInput,
        reply: CallReply<WikiReadReceipt>,
    },
    ReadBinaryFile {
        input: WikiReadBinaryInput,
        reply: CallReply<WikiReadBinaryReceipt>,
    },
    ReadSourcePreview {
        input: WikiReadInput,
        reply: CallReply<WikiReadReceipt>,
    },
    Search {
        input: WikiSearchInput,
        reply: CallReply<WikiSearchReceipt>,
    },
    Navigation {
        input: WikiProjectSelector,
        reply: CallReply<crate::WikiNavigation>,
    },
    Graph {
        input: WikiProjectSelector,
        reply: CallReply<WikiGraphReceipt>,
    },
    RetrieveContext {
        input: WikiRetrieveContextInput,
        reply: CallReply<WikiSearchReceipt>,
    },
    Reviews {
        input: WikiProjectSelector,
        reply: CallReply<WikiReviewsReceipt>,
    },
    SourceFiles {
        input: WikiProjectSelector,
        reply: CallReply<WikiSourceFilesReceipt>,
    },
    SearchConfig {
        input: WikiProjectSelector,
        reply: CallReply<crate::search_config::SearchConfig>,
    },
    SourceWatchConfig {
        input: WikiProjectSelector,
        reply: CallReply<WikiSourceWatchConfigReceipt>,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum WikiOwnerKey {
    Dedup(String),
    #[allow(dead_code)]
    Import(String),
    Embed(String),
    Commit(String),
}

impl WikiCommand {
    pub(crate) async fn reject(self, error: WikiFailure) {
        match self {
            Self::BeginSourceWork { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::StageReviewSweep { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CompleteReviewSweep { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::DetectDuplicates { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::EnqueueDedup { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CompleteDedup { reply, .. } | Self::FailDedup { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::PrepareDedup { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::RetryDedup { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ResumeDedup { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ExcludeDuplicates { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ApplySelection { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CreateMissingPage { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ReloadProjects { reply } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::RestoreHistory { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::UpdateHistoryConfig { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ClearHistory { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ExportArchive { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ImportArchive { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::RebuildIndex { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::StageQuestion { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CancelQuestion { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::SaveQuestion { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::StageReindex { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::StageLint { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::BeginLint { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CompleteLint { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::UpdateLintConfig { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::LintAction { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::DismissLint { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::DismissGraphInsight { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CreateProject { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::OpenProject { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::SetCurrentProject { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::UpdateSourceWatchConfig { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::WriteFile { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::StageImportSource { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ParseImportSource { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CommitImportSource { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::StageImportFolder { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::StageRefreshSources { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::StageRefreshSourcePaths { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CleanupDeletedWikiPages { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::DeletePage { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::DeleteSource { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::MigrateSourcePath { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ApplyGeneratedPages { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ResolveReview { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::DismissReview { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ClearResolvedReviews { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::RetrySourceTask { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::PauseSourceTask { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ResumeSourceTask { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ReorderSourceTask { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::Rescan { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::UpdateSearchConfig { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::EmbedPage { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
        }
    }

    pub(crate) fn acceptance(&self) -> Option<&WikiCallAcceptance> {
        match self {
            Self::DetectDuplicates { reply, .. } => reply.acceptance.as_ref(),
            Self::ApplySelection { reply, .. } => reply.acceptance.as_ref(),
            Self::CreateMissingPage { reply, .. } => reply.acceptance.as_ref(),
            Self::RestoreHistory { reply, .. } => reply.acceptance.as_ref(),
            Self::ClearHistory { reply, .. } => reply.acceptance.as_ref(),
            Self::ExportArchive { reply, .. } => reply.acceptance.as_ref(),
            Self::ImportArchive { reply, .. } => reply.acceptance.as_ref(),
            Self::RebuildIndex { reply, .. } => reply.acceptance.as_ref(),
            Self::SaveQuestion { reply, .. } => reply.acceptance.as_ref(),
            Self::LintAction { reply, .. } => reply.acceptance.as_ref(),
            Self::Rescan { reply, .. } => reply.acceptance.as_ref(),
            Self::EmbedPage { reply, .. } => reply.acceptance.as_ref(),
            Self::ApplyGeneratedPages { reply, .. } => reply.acceptance.as_ref(),
            Self::DeletePage { reply, .. } => reply.acceptance.as_ref(),
            Self::DeleteSource { reply, .. } => reply.acceptance.as_ref(),
            _ => None,
        }
    }

    pub(crate) fn call(&self) -> Option<&CallContext<WikiCallDetail>> {
        match self {
            Self::BeginSourceWork { reply, .. } => reply.call.as_ref(),
            Self::StageReviewSweep { reply, .. } => reply.call.as_ref(),
            Self::CompleteReviewSweep { reply, .. } => reply.call.as_ref(),
            Self::DetectDuplicates { reply, .. } => reply.call.as_ref(),
            Self::EnqueueDedup { reply, .. } => reply.call.as_ref(),
            Self::CompleteDedup { reply, .. } | Self::FailDedup { reply, .. } => {
                reply.call.as_ref()
            }
            Self::PrepareDedup { reply, .. } => reply.call.as_ref(),
            Self::RetryDedup { reply, .. } => reply.call.as_ref(),
            Self::ResumeDedup { reply, .. } => reply.call.as_ref(),
            Self::ExcludeDuplicates { reply, .. } => reply.call.as_ref(),
            Self::ApplySelection { reply, .. } => reply.call.as_ref(),
            Self::CreateMissingPage { reply, .. } => reply.call.as_ref(),
            Self::ReloadProjects { reply } => reply.call.as_ref(),
            Self::RestoreHistory { reply, .. } => reply.call.as_ref(),
            Self::UpdateHistoryConfig { reply, .. } => reply.call.as_ref(),
            Self::ClearHistory { reply, .. } => reply.call.as_ref(),
            Self::ExportArchive { reply, .. } => reply.call.as_ref(),
            Self::ImportArchive { reply, .. } => reply.call.as_ref(),
            Self::RebuildIndex { reply, .. } => reply.call.as_ref(),
            Self::StageQuestion { reply, .. } => reply.call.as_ref(),
            Self::CancelQuestion { reply, .. } => reply.call.as_ref(),
            Self::SaveQuestion { reply, .. } => reply.call.as_ref(),
            Self::StageReindex { reply, .. } => reply.call.as_ref(),
            Self::StageLint { reply, .. } => reply.call.as_ref(),
            Self::BeginLint { reply, .. } => reply.call.as_ref(),
            Self::CompleteLint { reply, .. } => reply.call.as_ref(),
            Self::UpdateLintConfig { reply, .. } => reply.call.as_ref(),
            Self::LintAction { reply, .. } => reply.call.as_ref(),
            Self::DismissLint { reply, .. } => reply.call.as_ref(),
            Self::DismissGraphInsight { reply, .. } => reply.call.as_ref(),
            Self::CreateProject { reply, .. } => reply.call.as_ref(),
            Self::OpenProject { reply, .. } => reply.call.as_ref(),
            Self::SetCurrentProject { reply, .. } => reply.call.as_ref(),
            Self::UpdateSourceWatchConfig { reply, .. } => reply.call.as_ref(),
            Self::WriteFile { reply, .. } => reply.call.as_ref(),
            Self::StageImportSource { reply, .. } => reply.call.as_ref(),
            Self::ParseImportSource { reply, .. } => reply.call.as_ref(),
            Self::CommitImportSource { reply, .. } => reply.call.as_ref(),
            Self::StageImportFolder { reply, .. } => reply.call.as_ref(),
            Self::StageRefreshSources { reply, .. } => reply.call.as_ref(),
            Self::StageRefreshSourcePaths { reply, .. } => reply.call.as_ref(),
            Self::CleanupDeletedWikiPages { reply, .. } => reply.call.as_ref(),
            Self::DeletePage { reply, .. } => reply.call.as_ref(),
            Self::DeleteSource { reply, .. } => reply.call.as_ref(),
            Self::MigrateSourcePath { reply, .. } => reply.call.as_ref(),
            Self::ApplyGeneratedPages { reply, .. } => reply.call.as_ref(),
            Self::ResolveReview { reply, .. } => reply.call.as_ref(),
            Self::DismissReview { reply, .. } => reply.call.as_ref(),
            Self::ClearResolvedReviews { reply, .. } => reply.call.as_ref(),
            Self::RetrySourceTask { reply, .. } => reply.call.as_ref(),
            Self::PauseSourceTask { reply, .. } => reply.call.as_ref(),
            Self::ResumeSourceTask { reply, .. } => reply.call.as_ref(),
            Self::ReorderSourceTask { reply, .. } => reply.call.as_ref(),
            Self::Rescan { reply, .. } => reply.call.as_ref(),
            Self::UpdateSearchConfig { reply, .. } => reply.call.as_ref(),
            Self::EmbedPage { reply, .. } => reply.call.as_ref(),
        }
    }

    pub(crate) fn set_call(&mut self, call: Option<CallContext<WikiCallDetail>>) {
        match self {
            Self::BeginSourceWork { reply, .. } => reply.call = call,
            Self::StageReviewSweep { reply, .. } => reply.call = call,
            Self::CompleteReviewSweep { reply, .. } => reply.call = call,
            Self::DetectDuplicates { reply, .. } => reply.call = call,
            Self::EnqueueDedup { reply, .. } => reply.call = call,
            Self::CompleteDedup { reply, .. } | Self::FailDedup { reply, .. } => reply.call = call,
            Self::PrepareDedup { reply, .. } => reply.call = call,
            Self::RetryDedup { reply, .. } => reply.call = call,
            Self::ResumeDedup { reply, .. } => reply.call = call,
            Self::ExcludeDuplicates { reply, .. } => reply.call = call,
            Self::ApplySelection { reply, .. } => reply.call = call,
            Self::CreateMissingPage { reply, .. } => reply.call = call,
            Self::ReloadProjects { reply } => reply.call = call,
            Self::RestoreHistory { reply, .. } => reply.call = call,
            Self::UpdateHistoryConfig { reply, .. } => reply.call = call,
            Self::ClearHistory { reply, .. } => reply.call = call,
            Self::ExportArchive { reply, .. } => reply.call = call,
            Self::ImportArchive { reply, .. } => reply.call = call,
            Self::RebuildIndex { reply, .. } => reply.call = call,
            Self::StageQuestion { reply, .. } => reply.call = call,
            Self::CancelQuestion { reply, .. } => reply.call = call,
            Self::SaveQuestion { reply, .. } => reply.call = call,
            Self::StageReindex { reply, .. } => reply.call = call,
            Self::StageLint { reply, .. } => reply.call = call,
            Self::BeginLint { reply, .. } => reply.call = call,
            Self::CompleteLint { reply, .. } => reply.call = call,
            Self::UpdateLintConfig { reply, .. } => reply.call = call,
            Self::LintAction { reply, .. } => reply.call = call,
            Self::DismissLint { reply, .. } => reply.call = call,
            Self::DismissGraphInsight { reply, .. } => reply.call = call,
            Self::CreateProject { reply, .. } => reply.call = call,
            Self::OpenProject { reply, .. } => reply.call = call,
            Self::SetCurrentProject { reply, .. } => reply.call = call,
            Self::UpdateSourceWatchConfig { reply, .. } => reply.call = call,
            Self::WriteFile { reply, .. } => reply.call = call,
            Self::StageImportSource { reply, .. } => reply.call = call,
            Self::ParseImportSource { reply, .. } => reply.call = call,
            Self::CommitImportSource { reply, .. } => reply.call = call,
            Self::StageImportFolder { reply, .. } => reply.call = call,
            Self::StageRefreshSources { reply, .. } => reply.call = call,
            Self::StageRefreshSourcePaths { reply, .. } => reply.call = call,
            Self::CleanupDeletedWikiPages { reply, .. } => reply.call = call,
            Self::DeletePage { reply, .. } => reply.call = call,
            Self::DeleteSource { reply, .. } => reply.call = call,
            Self::MigrateSourcePath { reply, .. } => reply.call = call,
            Self::ApplyGeneratedPages { reply, .. } => reply.call = call,
            Self::ResolveReview { reply, .. } => reply.call = call,
            Self::DismissReview { reply, .. } => reply.call = call,
            Self::ClearResolvedReviews { reply, .. } => reply.call = call,
            Self::RetrySourceTask { reply, .. } => reply.call = call,
            Self::PauseSourceTask { reply, .. } => reply.call = call,
            Self::ResumeSourceTask { reply, .. } => reply.call = call,
            Self::ReorderSourceTask { reply, .. } => reply.call = call,
            Self::Rescan { reply, .. } => reply.call = call,
            Self::UpdateSearchConfig { reply, .. } => reply.call = call,
            Self::EmbedPage { reply, .. } => reply.call = call,
        }
    }

    pub(crate) fn project_id_mut(&mut self) -> Option<&mut Option<String>> {
        match self {
            Self::ApplySelection { input, .. } => Some(&mut input.project_id),

            Self::EnqueueDedup { input, .. } => Some(&mut input.project_id),
            Self::FailDedup { input, .. } => Some(&mut input.project_id),
            Self::PrepareDedup { input, .. } => Some(&mut input.project_id),
            Self::RetryDedup { input, .. } => Some(&mut input.project_id),
            Self::ResumeDedup { input, .. } => Some(&mut input.project_id),
            Self::ExcludeDuplicates { input, .. } => Some(&mut input.project_id),

            Self::RestoreHistory { input, .. } => Some(&mut input.project_id),
            Self::UpdateHistoryConfig { input, .. } => Some(&mut input.project_id),
            Self::ClearHistory { input, .. } => Some(&mut input.project_id),
            Self::ExportArchive { input, .. } => Some(&mut input.project_id),
            Self::RebuildIndex { input, .. } => Some(&mut input.project_id),
            Self::StageQuestion { input, .. } => Some(&mut input.project_id),
            Self::CancelQuestion { input, .. } => Some(&mut input.project_id),
            Self::SaveQuestion { input, .. } => Some(&mut input.project_id),
            Self::StageReindex { input, .. } => Some(&mut input.project_id),
            Self::StageLint { input, .. } => Some(&mut input.project_id),
            Self::UpdateLintConfig { input, .. } => Some(&mut input.project_id),
            Self::LintAction { input, .. } => Some(&mut input.project_id),
            Self::DismissLint { input, .. } => Some(&mut input.project_id),
            Self::DismissGraphInsight { input, .. } => Some(&mut input.project_id),
            Self::UpdateSourceWatchConfig { input, .. } => Some(&mut input.project_id),
            Self::WriteFile { input, .. } => Some(&mut input.project_id),
            Self::StageImportSource { input, .. } => Some(&mut input.project_id),
            Self::StageImportFolder { input, .. } => Some(&mut input.project_id),
            Self::StageRefreshSources { input, .. } => Some(&mut input.project_id),
            Self::DeletePage { input, .. } => Some(&mut input.project_id),
            Self::DeleteSource { input, .. } => Some(&mut input.project_id),
            Self::ApplyGeneratedPages { input, .. } => Some(&mut input.project_id),
            Self::ResolveReview { input, .. } => Some(&mut input.project_id),
            Self::DismissReview { input, .. } => Some(&mut input.project_id),
            Self::ClearResolvedReviews { input, .. } => Some(&mut input.project_id),
            Self::RetrySourceTask { input, .. } => Some(&mut input.project_id),
            Self::PauseSourceTask { input, .. } => Some(&mut input.project_id),
            Self::ResumeSourceTask { input, .. } => Some(&mut input.project_id),
            Self::ReorderSourceTask { input, .. } => Some(&mut input.project_id),
            Self::Rescan { input, .. } => Some(&mut input.project_id),
            Self::UpdateSearchConfig { project_id, .. } => Some(project_id),
            Self::EmbedPage { input, .. } => Some(&mut input.project_id),
            _ => None,
        }
    }

    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<WikiOwnerKey> {
        use foundation::execution::CommandRoute;
        match self {
            Self::BeginSourceWork { project_id, .. }
            | Self::StageReviewSweep { project_id, .. } => {
                CommandRoute::Keyed(WikiOwnerKey::Commit(project_id.clone()))
            }
            Self::CompleteReviewSweep { plan, .. } => {
                CommandRoute::Keyed(WikiOwnerKey::Commit(plan.project_id.clone()))
            }
            Self::DetectDuplicates { plan, .. } => CommandRoute::Keyed(WikiOwnerKey::Dedup(plan.project_id.clone())),
            Self::EnqueueDedup { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::CompleteDedup { plan, .. } => {
                CommandRoute::Keyed(WikiOwnerKey::Commit(plan.project_id.clone()))
            }
            Self::FailDedup { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::PrepareDedup { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Dedup(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::RetryDedup { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::ResumeDedup { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::ExcludeDuplicates { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::ApplySelection { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::CreateMissingPage { plan, .. } => CommandRoute::Keyed(WikiOwnerKey::Commit(plan.project_id.clone())),
            Self::ImportArchive { .. } | Self::StageReindex { .. } => CommandRoute::Global,
            Self::BeginLint { plan, .. } | Self::CompleteLint { plan, .. } => {
                CommandRoute::Keyed(WikiOwnerKey::Commit(plan.project_id.clone()))
            }
            Self::RestoreHistory { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::UpdateHistoryConfig { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::ClearHistory { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::ExportArchive { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::RebuildIndex { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::StageQuestion { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::CancelQuestion { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::SaveQuestion { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::StageLint { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::UpdateLintConfig { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::LintAction { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::DismissLint { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::DismissGraphInsight { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::ReloadProjects { .. }
            | Self::CreateProject { .. }
            | Self::OpenProject { .. }
            | Self::SetCurrentProject { .. } => CommandRoute::Global,
            Self::UpdateSourceWatchConfig { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::WriteFile { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::StageImportSource { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::StageImportFolder { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::StageRefreshSources { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::StageRefreshSourcePaths { project_id, .. }
            | Self::CleanupDeletedWikiPages { project_id, .. } => {
                CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
            }
            Self::ParseImportSource { input, .. } => {
                CommandRoute::Keyed(WikiOwnerKey::Import(input.import_id.clone()))
            }
            Self::CommitImportSource { input, .. } => CommandRoute::Keyed(WikiOwnerKey::Commit(
                project_lane(Some(&input.staged.project_id)),
            )),
            Self::DeletePage { input, .. } => match input.project_id.as_deref() {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.to_owned())),
                None => CommandRoute::Global,
            },
            Self::DeleteSource { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::MigrateSourcePath { project_id, .. } => {
                CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
            }
            Self::ApplyGeneratedPages { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::ResolveReview { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::DismissReview { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::ClearResolvedReviews { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::RetrySourceTask { input, .. }
            | Self::PauseSourceTask { input, .. }
            | Self::ResumeSourceTask { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::ReorderSourceTask { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::Rescan { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => {
                    CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
                }
                None => CommandRoute::Global,
            },
            Self::UpdateSearchConfig { project_id, .. } => match project_id {
                Some(id) => CommandRoute::Keyed(WikiOwnerKey::Commit(id.clone())),
                None => CommandRoute::Global,
            },
            Self::EmbedPage { input, .. } => match input.project_id.as_deref() {
                Some(project_id) => CommandRoute::Keyed(WikiOwnerKey::Embed(page_lane(
                    Some(project_id),
                    &input.relative_path,
                ))),
                None => CommandRoute::Global,
            },
        }
    }
}

impl WikiQuery {
    pub(crate) async fn reject(self, error: WikiFailure) {
        match self {
            Self::StageSelection { reply, .. } => { let _ = reply.send(Err(error)).await; }
            Self::SelectionTask { reply, .. } | Self::CancelSelection { reply, .. } => { let _ = reply.send(Err(error)).await; }
            Self::StageDedupDetection { reply, .. } => { let _ = reply.send(Err(error)).await; }
            Self::DedupState { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CancelDedup { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::PageLinks { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::StageMissingPage { reply, .. } => { let _ = reply.send(Err(error)).await; }
            Self::CancelMissingPage { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::HistoryList { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::HistoryConfig { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::HistoryStats { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::QuestionTask { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ReindexState { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::LintConfig { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::LintState { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CancelLint { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::GraphInsights { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::Status { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::Projects { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ProjectTemplates { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::Files { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ReadFile { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ReadBinaryFile { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::ReadSourcePreview { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::Search { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::Navigation { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::Graph { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::RetrieveContext { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::Reviews { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::SourceFiles { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::SearchConfig { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::SourceWatchConfig { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
        }
    }

    pub(crate) fn call(&self) -> Option<&CallContext<WikiCallDetail>> {
        match self {
            Self::StageSelection { reply, .. } => reply.call.as_ref(),
            Self::SelectionTask { reply, .. } | Self::CancelSelection { reply, .. } => reply.call.as_ref(),
            Self::StageDedupDetection { reply, .. } => reply.call.as_ref(),
            Self::DedupState { reply, .. } => reply.call.as_ref(),
            Self::CancelDedup { reply, .. } => reply.call.as_ref(),
            Self::PageLinks { reply, .. } => reply.call.as_ref(),
            Self::StageMissingPage { reply, .. } => reply.call.as_ref(),
            Self::CancelMissingPage { reply, .. } => reply.call.as_ref(),
            Self::HistoryList { reply, .. } => reply.call.as_ref(),
            Self::HistoryConfig { reply, .. } => reply.call.as_ref(),
            Self::HistoryStats { reply, .. } => reply.call.as_ref(),
            Self::QuestionTask { reply, .. } => reply.call.as_ref(),
            Self::ReindexState { reply, .. } => reply.call.as_ref(),
            Self::LintConfig { reply, .. } => reply.call.as_ref(),
            Self::LintState { reply, .. } => reply.call.as_ref(),
            Self::CancelLint { reply, .. } => reply.call.as_ref(),
            Self::GraphInsights { reply, .. } => reply.call.as_ref(),
            Self::Status { reply, .. } => reply.call.as_ref(),
            Self::Projects { reply, .. } => reply.call.as_ref(),
            Self::ProjectTemplates { reply, .. } => reply.call.as_ref(),
            Self::Files { reply, .. } => reply.call.as_ref(),
            Self::ReadFile { reply, .. } => reply.call.as_ref(),
            Self::ReadBinaryFile { reply, .. } => reply.call.as_ref(),
            Self::ReadSourcePreview { reply, .. } => reply.call.as_ref(),
            Self::Search { reply, .. } => reply.call.as_ref(),
            Self::Navigation { reply, .. } => reply.call.as_ref(),
            Self::Graph { reply, .. } => reply.call.as_ref(),
            Self::RetrieveContext { reply, .. } => reply.call.as_ref(),
            Self::Reviews { reply, .. } => reply.call.as_ref(),
            Self::SourceFiles { reply, .. } => reply.call.as_ref(),
            Self::SearchConfig { reply, .. } => reply.call.as_ref(),
            Self::SourceWatchConfig { reply, .. } => reply.call.as_ref(),
        }
    }

    pub(crate) fn set_call(&mut self, call: Option<CallContext<WikiCallDetail>>) {
        match self {
            Self::StageSelection { reply, .. } => reply.call = call,
            Self::SelectionTask { reply, .. } | Self::CancelSelection { reply, .. } => reply.call = call,
            Self::StageDedupDetection { reply, .. } => reply.call = call,
            Self::DedupState { reply, .. } => reply.call = call,
            Self::CancelDedup { reply, .. } => reply.call = call,
            Self::PageLinks { reply, .. } => reply.call = call,
            Self::StageMissingPage { reply, .. } => reply.call = call,
            Self::CancelMissingPage { reply, .. } => reply.call = call,
            Self::HistoryList { reply, .. } => reply.call = call,
            Self::HistoryConfig { reply, .. } => reply.call = call,
            Self::HistoryStats { reply, .. } => reply.call = call,
            Self::QuestionTask { reply, .. } => reply.call = call,
            Self::ReindexState { reply, .. } => reply.call = call,
            Self::LintConfig { reply, .. } => reply.call = call,
            Self::LintState { reply, .. } => reply.call = call,
            Self::CancelLint { reply, .. } => reply.call = call,
            Self::GraphInsights { reply, .. } => reply.call = call,
            Self::Status { reply, .. } => reply.call = call,
            Self::Projects { reply, .. } => reply.call = call,
            Self::ProjectTemplates { reply, .. } => reply.call = call,
            Self::Files { reply, .. } => reply.call = call,
            Self::ReadFile { reply, .. } => reply.call = call,
            Self::ReadBinaryFile { reply, .. } => reply.call = call,
            Self::ReadSourcePreview { reply, .. } => reply.call = call,
            Self::Search { reply, .. } => reply.call = call,
            Self::Navigation { reply, .. } => reply.call = call,
            Self::Graph { reply, .. } => reply.call = call,
            Self::RetrieveContext { reply, .. } => reply.call = call,
            Self::Reviews { reply, .. } => reply.call = call,
            Self::SourceFiles { reply, .. } => reply.call = call,
            Self::SearchConfig { reply, .. } => reply.call = call,
            Self::SourceWatchConfig { reply, .. } => reply.call = call,
        }
    }

    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<WikiOwnerKey> {
        foundation::execution::QueryRoute::Direct
    }
}

fn project_lane(project_id: Option<&str>) -> String {
    project_id.unwrap_or("__current__").to_owned()
}

fn page_lane(project_id: Option<&str>, relative_path: &str) -> String {
    format!("{}:{relative_path}", project_lane(project_id))
}

#[cfg(test)]
mod tests {
    use foundation::execution::{CommandRoute, QueryRoute};

    use super::*;

    fn reply<T>() -> CallReply<T> {
        let (reply, _response) = tokio::sync::oneshot::channel();
        CallReply::new(reply)
    }

    #[test]
    fn registry_mutations_stay_on_global_lane() {
        assert_eq!(
            WikiCommand::CreateProject {
                input: WikiCreateProjectInput {
                    root_path: "project".to_owned(),
                    title: None,
                    template_id: None,
                },
                reply: reply(),
            }
            .route(),
            CommandRoute::Global,
        );
        assert_eq!(
            WikiCommand::OpenProject {
                input: WikiOpenProjectInput {
                    root_path: "project".to_owned(),
                    title: None,
                },
                reply: reply(),
            }
            .route(),
            CommandRoute::Global,
        );
        assert_eq!(
            WikiCommand::SetCurrentProject {
                input: WikiProjectSelector {
                    project_id: Some("project-a".to_owned()),
                },
                reply: reply(),
            }
            .route(),
            CommandRoute::Global,
        );
    }

    #[test]
    fn explicit_project_writes_use_keyed_lanes() {
        assert_eq!(
            WikiCommand::WriteFile {
                input: WikiWriteInput {
                    project_id: Some("project-a".to_owned()),
                    relative_path: "wiki/sources/a.md".to_owned(),
                    content: "alpha".to_owned(),
                },
                reply: reply(),
            }
            .route(),
            CommandRoute::Keyed(WikiOwnerKey::Commit("project-a".to_owned())),
        );
        assert_eq!(
            WikiCommand::Rescan {
                input: WikiProjectSelector {
                    project_id: Some("project-a".to_owned()),
                },
                reply: reply(),
            }
            .route(),
            CommandRoute::Keyed(WikiOwnerKey::Commit("project-a".to_owned())),
        );
        assert_eq!(
            WikiCommand::StageImportSource {
                input: WikiImportSourceInput {
                    project_id: Some("project-a".to_owned()),
                    source_path: "source.pdf".to_owned(),
                },
                reply: reply(),
            }
            .route(),
            CommandRoute::Keyed(WikiOwnerKey::Commit("project-a".to_owned())),
        );
        let staged = WikiStagedImportSource {
            task_id: "task-a".to_owned(),
            execution: None,
            project_id: "project-a".to_owned(),
            project_root: PathBuf::from("project"),
            import_id: "import-a".to_owned(),
            source_path: PathBuf::from("project/raw/sources/source.pdf"),
            source_relative_path: "raw/sources/source.pdf".to_owned(),
            source_identity: "source.pdf".to_owned(),
            page_relative_path: "wiki/sources/source.md".to_owned(),
            task_kind: WikiSourceTaskKind::Imported,
        };
        assert_eq!(
            WikiCommand::ParseImportSource {
                input: staged.clone(),
                reply: reply(),
            }
            .route(),
            CommandRoute::Keyed(WikiOwnerKey::Import("import-a".to_owned())),
        );
        assert_eq!(
            WikiCommand::CommitImportSource {
                input: WikiParsedImportSource {
                    staged,
                    text: "alpha".to_owned(),
                    images: Vec::new(),
                },
                reply: reply(),
            }
            .route(),
            CommandRoute::Keyed(WikiOwnerKey::Commit("project-a".to_owned())),
        );
        assert_eq!(
            WikiCommand::EmbedPage {
                input: WikiPathSelector {
                    project_id: Some("project-a".to_owned()),
                    relative_path: "wiki/sources/a.md".to_owned(),
                },
                reply: reply(),
            }
            .route(),
            CommandRoute::Keyed(WikiOwnerKey::Embed(
                "project-a:wiki/sources/a.md".to_owned(),
            )),
        );
    }

    #[test]
    fn current_project_writes_resolve_before_keyed_lane() {
        assert_eq!(
            WikiCommand::WriteFile {
                input: WikiWriteInput {
                    project_id: None,
                    relative_path: "wiki/sources/a.md".to_owned(),
                    content: "alpha".to_owned(),
                },
                reply: reply(),
            }
            .route(),
            CommandRoute::Global,
        );
    }

    #[test]
    fn queries_are_direct() {
        assert_eq!(
            WikiQuery::Status { reply: reply() }.route(),
            QueryRoute::Direct,
        );
        assert_eq!(
            WikiQuery::RetrieveContext {
                input: WikiRetrieveContextInput {
                    project_id: Some("project-a".to_owned()),
                    query: "alpha".to_owned(),
                    limit: 4,
                },
                reply: reply(),
            }
            .route(),
            QueryRoute::Direct,
        );
    }
}
