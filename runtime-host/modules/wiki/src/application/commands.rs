use std::path::PathBuf;

use tokio::sync::oneshot;

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
        reply: oneshot::Sender<Result<WikiProjectsReceipt, WikiFailure>>,
    },
    OpenProject {
        input: WikiOpenProjectInput,
        reply: oneshot::Sender<Result<WikiProjectsReceipt, WikiFailure>>,
    },
    SetCurrentProject {
        input: WikiProjectSelector,
        reply: oneshot::Sender<Result<WikiProjectsReceipt, WikiFailure>>,
    },
    UpdateSourceWatchConfig {
        input: WikiSourceWatchConfigInput,
        reply: oneshot::Sender<Result<WikiSourceWatchConfigReceipt, WikiFailure>>,
    },
    WriteFile {
        input: WikiWriteInput,
        reply: oneshot::Sender<Result<WikiWriteReceipt, WikiFailure>>,
    },
    StageImportSource {
        input: WikiImportSourceInput,
        reply: oneshot::Sender<Result<WikiStagedImportSource, WikiFailure>>,
    },
    ParseImportSource {
        input: WikiStagedImportSource,
        reply: oneshot::Sender<Result<WikiParsedImportSource, WikiFailure>>,
    },
    CommitImportSource {
        input: WikiParsedImportSource,
        reply: oneshot::Sender<Result<WikiImportSourceReceipt, WikiFailure>>,
    },
    StageImportFolder {
        input: WikiImportFolderInput,
        reply: oneshot::Sender<Result<WikiImportFolderPlan, WikiFailure>>,
    },
    StageRefreshSources {
        input: WikiProjectSelector,
        reply: oneshot::Sender<Result<WikiRefreshSourcesPlan, WikiFailure>>,
    },
    StageRefreshSourcePaths {
        project_id: String,
        paths: Vec<PathBuf>,
        reply: oneshot::Sender<Result<WikiRefreshSourcesPlan, WikiFailure>>,
    },
    CleanupDeletedWikiPages {
        project_id: String,
        paths: Vec<String>,
        reply: oneshot::Sender<Result<(), WikiFailure>>,
    },
    DeleteSource {
        input: WikiDeleteSourceInput,
        reply: oneshot::Sender<Result<WikiDeleteSourceReceipt, WikiFailure>>,
    },
    MigrateSourcePath {
        project_id: String,
        old_source_relative_path: String,
        new_source_relative_path: String,
        reply: oneshot::Sender<Result<WikiSourceMoveReceipt, WikiFailure>>,
    },
    ApplyGeneratedPages {
        input: WikiApplyGeneratedPagesInput,
        reply: oneshot::Sender<Result<WikiApplyGeneratedPagesReceipt, WikiFailure>>,
    },
    ResolveReview {
        input: WikiReviewResolveInput,
        reply: oneshot::Sender<Result<WikiReviewsReceipt, WikiFailure>>,
    },
    DismissReview {
        input: WikiReviewDismissInput,
        reply: oneshot::Sender<Result<WikiReviewsReceipt, WikiFailure>>,
    },
    ClearResolvedReviews {
        input: WikiReviewClearResolvedInput,
        reply: oneshot::Sender<Result<WikiReviewsReceipt, WikiFailure>>,
    },
    MarkSourceTaskFailed {
        project_id: String,
        source_relative_path: String,
        error: String,
        reply: oneshot::Sender<Result<(), WikiFailure>>,
    },
    CancelSourceTask {
        input: WikiCancelSourceTaskInput,
        reply: oneshot::Sender<Result<WikiSourceTasksReceipt, WikiFailure>>,
    },
    RetrySourceTask {
        input: WikiSourceTaskActionInput,
        reply: oneshot::Sender<Result<WikiSourceTaskRunPlan, WikiFailure>>,
    },
    PauseSourceTask {
        input: WikiSourceTaskActionInput,
        reply: oneshot::Sender<Result<WikiSourceTasksReceipt, WikiFailure>>,
    },
    ResumeSourceTask {
        input: WikiSourceTaskActionInput,
        reply: oneshot::Sender<Result<WikiSourceTaskRunPlan, WikiFailure>>,
    },
    ReorderSourceTask {
        input: WikiReorderSourceTaskInput,
        reply: oneshot::Sender<Result<WikiSourceTasksReceipt, WikiFailure>>,
    },
    Rescan {
        input: WikiProjectSelector,
        reply: oneshot::Sender<Result<WikiStatusReceipt, WikiFailure>>,
    },
    EmbedPage {
        input: WikiPathSelector,
        reply: oneshot::Sender<Result<(), WikiFailure>>,
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
    pub staged: Option<WikiStagedImportSource>,
}

pub(crate) enum WikiQuery {
    Status {
        reply: oneshot::Sender<Result<WikiStatusReceipt, WikiFailure>>,
    },
    Projects {
        reply: oneshot::Sender<Result<WikiProjectsReceipt, WikiFailure>>,
    },
    ProjectTemplates {
        reply: oneshot::Sender<Result<WikiProjectTemplatesReceipt, WikiFailure>>,
    },
    Files {
        input: WikiFilesInput,
        reply: oneshot::Sender<Result<WikiFilesReceipt, WikiFailure>>,
    },
    ReadFile {
        input: WikiReadInput,
        reply: oneshot::Sender<Result<WikiReadReceipt, WikiFailure>>,
    },
    ReadBinaryFile {
        input: WikiReadBinaryInput,
        reply: oneshot::Sender<Result<WikiReadBinaryReceipt, WikiFailure>>,
    },
    ReadSourcePreview {
        input: WikiReadInput,
        reply: oneshot::Sender<Result<WikiReadReceipt, WikiFailure>>,
    },
    Search {
        input: WikiSearchInput,
        reply: oneshot::Sender<Result<WikiSearchReceipt, WikiFailure>>,
    },
    Graph {
        input: WikiProjectSelector,
        reply: oneshot::Sender<Result<WikiGraphReceipt, WikiFailure>>,
    },
    RetrieveContext {
        input: WikiRetrieveContextInput,
        reply: oneshot::Sender<Result<WikiSearchReceipt, WikiFailure>>,
    },
    Reviews {
        input: WikiProjectSelector,
        reply: oneshot::Sender<Result<WikiReviewsReceipt, WikiFailure>>,
    },
    SourceTasks {
        input: WikiProjectSelector,
        reply: oneshot::Sender<Result<WikiSourceTasksReceipt, WikiFailure>>,
    },
    SourceFiles {
        input: WikiProjectSelector,
        reply: oneshot::Sender<Result<WikiSourceFilesReceipt, WikiFailure>>,
    },
    SourceWatchConfig {
        input: WikiProjectSelector,
        reply: oneshot::Sender<Result<WikiSourceWatchConfigReceipt, WikiFailure>>,
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

    fn reply<T>() -> oneshot::Sender<T> {
        let (reply, _response) = oneshot::channel();
        reply
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
