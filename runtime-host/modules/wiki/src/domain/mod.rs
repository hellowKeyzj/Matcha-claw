mod chunk;
mod error;
mod graph;
mod layout;
mod maintenance;
pub mod model;
mod pages;
mod path;
mod revision;
mod search;
mod selection;
mod templates;

pub use chunk::{WikiChunk, chunk_markdown_with_overlap};
pub use error::WikiFailure;
pub(crate) use graph::wiki_links;
pub use graph::{WikiGraphCommunity, WikiGraphEdge, WikiGraphNode, WikiGraphReceipt, build_graph};
pub use layout::{
    RAW_SOURCES_DIR, WIKI_MEDIA_DIR, WIKI_SOURCES_DIR, ensure_project_layout,
    ensure_project_layout_for_template, layout_status,
};
pub use maintenance::*;
pub use selection::*;
pub use model::{
    WikiApplyGeneratedPagesInput, WikiApplyGeneratedPagesReceipt, WikiArchiveExportInput,
    WikiArchiveImportInput, WikiCancelSourceTaskInput, WikiCreateProjectInput,
    WikiDeleteSourceInput, WikiDeleteSourceReceipt, WikiFileEntry, WikiFilesInput,
    WikiFilesReceipt, WikiGeneratedPageInput, WikiImportFolderInput, WikiImportFolderReceipt,
    WikiImportSourceInput, WikiImportSourceReceipt, WikiLayoutStatus, WikiOpenProjectInput,
    WikiPathSelector, WikiProjectRecord, WikiProjectRegistry, WikiProjectSelector,
    WikiProjectTemplateView, WikiProjectTemplatesReceipt, WikiProjectView, WikiProjectsReceipt,
    WikiQuestionHistory, WikiQuestionHistoryRole, WikiQuestionInput, WikiQuestionReference,
    WikiQuestionSaveReceipt, WikiQuestionStatus, WikiQuestionTask, WikiQuestionTaskReceipt,
    WikiQuestionTaskSelector, WikiReadBinaryInput, WikiReadBinaryReceipt, WikiReadInput,
    WikiReadReceipt, WikiRebuildIndexReceipt, WikiRefreshSourcesReceipt,
    WikiReorderSourceTaskInput, WikiRetrieveContextInput, WikiReviewClearResolvedInput,
    WikiReviewDismissInput, WikiReviewItem, WikiReviewOption, WikiReviewResolveInput,
    WikiReviewType, WikiReviewsReceipt, WikiSearchHit, WikiSearchImage, WikiSearchInput,
    WikiSearchReceipt, WikiSourceFilesReceipt, WikiSourceMoveReceipt, WikiSourceSkip,
    WikiSourceTask, WikiSourceTaskActionInput, WikiSourceTaskKind, WikiSourceTaskStatus,
    WikiSourceTasksReceipt, WikiSourceWatchConfig, WikiSourceWatchConfigInput,
    WikiSourceWatchConfigReceipt, WikiStatusReceipt, WikiWriteInput, WikiWriteReceipt,
};
pub use pages::{
    WikiDeletePageFailure, WikiDeletePageInput, WikiDeletePageReceipt, WikiDeletePageStage,
    WikiNavigation, WikiNavigationPage,
};
pub(crate) use path::safe_relative_path;
pub use path::{
    absolute_clean_path, normalize_relative_path, project_id_for_root, resolve_project_path,
    title_for_root,
};
pub use revision::{WikiRevision, now_ms, stable_content_hash, system_time_ms};
pub(crate) use search::search_snippet;
pub use search::{
    SearchPage, extract_search_images, extract_search_title, finish_search, keyword_hits,
    load_search_pages,
};
pub use templates::{project_template_or_default, project_template_views};
