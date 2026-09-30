use std::path::PathBuf;

use crate::call::{CallReply, WikiCallAcceptance, WikiCallDetail};
use platform::call::CallContext;

use crate::domain::{
    WikiApplyGeneratedPagesInput, WikiApplyGeneratedPagesReceipt, WikiCancelSourceTaskInput,
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
        reply: CallReply<WikiRefreshSourcesPlan>,
    },
    CleanupDeletedWikiPages {
        project_id: String,
        paths: Vec<String>,
        reply: CallReply<()>,
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
    MarkSourceTaskFailed {
        project_id: String,
        source_relative_path: String,
        error: String,
        reply: CallReply<()>,
    },
    CancelSourceTask {
        input: WikiCancelSourceTaskInput,
        reply: CallReply<WikiSourceTasksReceipt>,
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
    EmbedPage {
        input: WikiPathSelector,
        reply: CallReply<()>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WikiStagedImportSource {
    pub project_id: String,
    pub project_root: PathBuf,
    pub import_id: String,
    pub source_path: PathBuf,
    pub source_relative_path: String,
    pub source_identity: String,
    pub page_relative_path: String,
    pub task_kind: WikiSourceTaskKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
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
    pub project_id: String,
    pub source_relative_path: String,
    pub staged: Option<WikiStagedImportSource>,
}

pub(crate) enum WikiQuery {
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
    SourceTasks {
        input: WikiProjectSelector,
        reply: CallReply<WikiSourceTasksReceipt>,
    },
    SourceFiles {
        input: WikiProjectSelector,
        reply: CallReply<WikiSourceFilesReceipt>,
    },
    SourceWatchConfig {
        input: WikiProjectSelector,
        reply: CallReply<WikiSourceWatchConfigReceipt>,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum WikiOwnerKey {
    #[allow(dead_code)]
    Import(String),
    Embed(String),
    Commit(String),
}

impl WikiCommand {
    pub(crate) async fn reject(self, error: WikiFailure) {
        match self {
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
            Self::MarkSourceTaskFailed { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::CancelSourceTask { reply, .. } => {
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
            Self::EmbedPage { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
        }
    }

    pub(crate) fn acceptance(&self) -> Option<&WikiCallAcceptance> {
        match self {
            Self::Rescan { reply, .. } => reply.acceptance.as_ref(),
            Self::EmbedPage { reply, .. } => reply.acceptance.as_ref(),
            Self::ApplyGeneratedPages { reply, .. } => reply.acceptance.as_ref(),
            Self::DeleteSource { reply, .. } => reply.acceptance.as_ref(),
            _ => None,
        }
    }

    pub(crate) fn call(&self) -> Option<&CallContext<WikiCallDetail>> {
        match self {
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
            Self::DeleteSource { reply, .. } => reply.call.as_ref(),
            Self::MigrateSourcePath { reply, .. } => reply.call.as_ref(),
            Self::ApplyGeneratedPages { reply, .. } => reply.call.as_ref(),
            Self::ResolveReview { reply, .. } => reply.call.as_ref(),
            Self::DismissReview { reply, .. } => reply.call.as_ref(),
            Self::ClearResolvedReviews { reply, .. } => reply.call.as_ref(),
            Self::MarkSourceTaskFailed { reply, .. } => reply.call.as_ref(),
            Self::CancelSourceTask { reply, .. } => reply.call.as_ref(),
            Self::RetrySourceTask { reply, .. } => reply.call.as_ref(),
            Self::PauseSourceTask { reply, .. } => reply.call.as_ref(),
            Self::ResumeSourceTask { reply, .. } => reply.call.as_ref(),
            Self::ReorderSourceTask { reply, .. } => reply.call.as_ref(),
            Self::Rescan { reply, .. } => reply.call.as_ref(),
            Self::EmbedPage { reply, .. } => reply.call.as_ref(),
        }
    }

    pub(crate) fn set_call(&mut self, call: Option<CallContext<WikiCallDetail>>) {
        match self {
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
            Self::DeleteSource { reply, .. } => reply.call = call,
            Self::MigrateSourcePath { reply, .. } => reply.call = call,
            Self::ApplyGeneratedPages { reply, .. } => reply.call = call,
            Self::ResolveReview { reply, .. } => reply.call = call,
            Self::DismissReview { reply, .. } => reply.call = call,
            Self::ClearResolvedReviews { reply, .. } => reply.call = call,
            Self::MarkSourceTaskFailed { reply, .. } => reply.call = call,
            Self::CancelSourceTask { reply, .. } => reply.call = call,
            Self::RetrySourceTask { reply, .. } => reply.call = call,
            Self::PauseSourceTask { reply, .. } => reply.call = call,
            Self::ResumeSourceTask { reply, .. } => reply.call = call,
            Self::ReorderSourceTask { reply, .. } => reply.call = call,
            Self::Rescan { reply, .. } => reply.call = call,
            Self::EmbedPage { reply, .. } => reply.call = call,
        }
    }

    pub(crate) fn project_id_mut(&mut self) -> Option<&mut Option<String>> {
        match self {
            Self::UpdateSourceWatchConfig { input, .. } => Some(&mut input.project_id),
            Self::WriteFile { input, .. } => Some(&mut input.project_id),
            Self::StageImportSource { input, .. } => Some(&mut input.project_id),
            Self::StageImportFolder { input, .. } => Some(&mut input.project_id),
            Self::StageRefreshSources { input, .. } => Some(&mut input.project_id),
            Self::DeleteSource { input, .. } => Some(&mut input.project_id),
            Self::ApplyGeneratedPages { input, .. } => Some(&mut input.project_id),
            Self::ResolveReview { input, .. } => Some(&mut input.project_id),
            Self::DismissReview { input, .. } => Some(&mut input.project_id),
            Self::ClearResolvedReviews { input, .. } => Some(&mut input.project_id),
            Self::CancelSourceTask { input, .. } => Some(&mut input.project_id),
            Self::RetrySourceTask { input, .. } => Some(&mut input.project_id),
            Self::PauseSourceTask { input, .. } => Some(&mut input.project_id),
            Self::ResumeSourceTask { input, .. } => Some(&mut input.project_id),
            Self::ReorderSourceTask { input, .. } => Some(&mut input.project_id),
            Self::Rescan { input, .. } => Some(&mut input.project_id),
            Self::EmbedPage { input, .. } => Some(&mut input.project_id),
            _ => None,
        }
    }

    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<WikiOwnerKey> {
        use foundation::execution::CommandRoute;
        match self {
            Self::CreateProject { .. }
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
            Self::MarkSourceTaskFailed { project_id, .. } => {
                CommandRoute::Keyed(WikiOwnerKey::Commit(project_lane(Some(project_id))))
            }
            Self::CancelSourceTask { input, .. } => match input.project_id.as_deref() {
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
            Self::Graph { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::RetrieveContext { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::Reviews { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::SourceTasks { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::SourceFiles { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
            Self::SourceWatchConfig { reply, .. } => {
                let _ = reply.send(Err(error)).await;
            }
        }
    }

    pub(crate) fn call(&self) -> Option<&CallContext<WikiCallDetail>> {
        match self {
            Self::Status { reply, .. } => reply.call.as_ref(),
            Self::Projects { reply, .. } => reply.call.as_ref(),
            Self::ProjectTemplates { reply, .. } => reply.call.as_ref(),
            Self::Files { reply, .. } => reply.call.as_ref(),
            Self::ReadFile { reply, .. } => reply.call.as_ref(),
            Self::ReadBinaryFile { reply, .. } => reply.call.as_ref(),
            Self::ReadSourcePreview { reply, .. } => reply.call.as_ref(),
            Self::Search { reply, .. } => reply.call.as_ref(),
            Self::Graph { reply, .. } => reply.call.as_ref(),
            Self::RetrieveContext { reply, .. } => reply.call.as_ref(),
            Self::Reviews { reply, .. } => reply.call.as_ref(),
            Self::SourceTasks { reply, .. } => reply.call.as_ref(),
            Self::SourceFiles { reply, .. } => reply.call.as_ref(),
            Self::SourceWatchConfig { reply, .. } => reply.call.as_ref(),
        }
    }

    pub(crate) fn set_call(&mut self, call: Option<CallContext<WikiCallDetail>>) {
        match self {
            Self::Status { reply, .. } => reply.call = call,
            Self::Projects { reply, .. } => reply.call = call,
            Self::ProjectTemplates { reply, .. } => reply.call = call,
            Self::Files { reply, .. } => reply.call = call,
            Self::ReadFile { reply, .. } => reply.call = call,
            Self::ReadBinaryFile { reply, .. } => reply.call = call,
            Self::ReadSourcePreview { reply, .. } => reply.call = call,
            Self::Search { reply, .. } => reply.call = call,
            Self::Graph { reply, .. } => reply.call = call,
            Self::RetrieveContext { reply, .. } => reply.call = call,
            Self::Reviews { reply, .. } => reply.call = call,
            Self::SourceTasks { reply, .. } => reply.call = call,
            Self::SourceFiles { reply, .. } => reply.call = call,
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
