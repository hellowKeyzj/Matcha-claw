mod adapters;
mod api;
mod application;
pub mod archive;
mod call;
mod call_result;
pub mod capability;
mod domain;
mod dedup;
mod page_links;
mod sweep;
mod selection;
pub mod embedding;
pub mod history;
pub mod index;
mod ingest;
pub mod insights;
pub mod lint;
mod owner;
pub mod ports;
pub mod preprocess;
mod qa;
pub mod reindex;
pub mod search_config;
pub mod vector;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

pub use api::WikiHandle;
use owner::actor::WikiOwner;

const MODULE_ID: ModuleId = ModuleId::new("wiki");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("wiki")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.wiki")];
const ROUTES: &[&str] = &["wiki.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[
    EffectKind::OwnerTask,
    EffectKind::Route,
    EffectKind::FilesystemRead,
    EffectKind::FilesystemWrite,
];

pub use domain::{
    WikiApplyGeneratedPagesInput, WikiApplyGeneratedPagesReceipt, WikiArchiveExportInput,
    WikiArchiveImportInput, WikiCancelSourceTaskInput, WikiCreateProjectInput,
    WikiDeleteSourceInput, WikiDeleteSourceReceipt, WikiFailure, WikiFileEntry, WikiFilesInput,
    WikiFilesReceipt, WikiGeneratedPageInput, WikiGraphCommunity, WikiGraphEdge, WikiGraphNode,
    WikiGraphReceipt, WikiImportFolderInput, WikiImportFolderReceipt, WikiImportSourceInput,
    WikiImportSourceReceipt, WikiLayoutStatus, WikiOpenProjectInput, WikiPathSelector,
    WikiProjectRecord, WikiProjectRegistry, WikiProjectSelector, WikiProjectTemplateView,
    WikiProjectTemplatesReceipt, WikiProjectView, WikiProjectsReceipt, WikiQuestionHistory,
    WikiQuestionHistoryRole, WikiQuestionInput, WikiQuestionReference, WikiQuestionSaveReceipt,
    WikiQuestionStatus, WikiQuestionTask, WikiQuestionTaskReceipt, WikiQuestionTaskSelector,
    WikiReadBinaryInput, WikiReadBinaryReceipt, WikiReadInput, WikiReadReceipt,
    WikiRebuildIndexReceipt, WikiRefreshSourcesReceipt, WikiRetrieveContextInput,
    WikiReviewClearResolvedInput, WikiReviewDismissInput, WikiReviewItem, WikiReviewOption,
    WikiReviewResolveInput, WikiReviewType, WikiReviewsReceipt, WikiRevision, WikiSearchHit,
    WikiSearchImage, WikiSearchInput, WikiSearchReceipt, WikiSourceMoveReceipt, WikiSourceSkip,
    WikiSourceTask, WikiSourceTaskKind, WikiSourceTaskStatus, WikiSourceTasksReceipt,
    WikiSourceWatchConfig, WikiSourceWatchConfigInput, WikiSourceWatchConfigReceipt,
    WikiStatusReceipt, WikiWriteInput, WikiWriteReceipt,
};
pub use domain::{
    WikiDeletePageFailure, WikiDeletePageInput, WikiDeletePageReceipt, WikiDeletePageStage,
    WikiNavigation, WikiNavigationPage,
};
pub use domain::{
    WikiDedupDetectInput, WikiDedupDetection, WikiDedupExcludeInput, WikiDedupMergeInput,
    WikiDedupState, WikiDedupTask, WikiDedupTaskInput, WikiDedupTaskStatus, WikiDuplicateGroup,
    WikiMissingPageCancelInput, WikiMissingPageInput, WikiMissingPageReceipt, WikiPageLink,
    WikiPageLinks,
};
pub use domain::{
    WikiSelectionApplyInput, WikiSelectionApplyReceipt, WikiSelectionInput,
    WikiSelectionIntent, WikiSelectionReference, WikiSelectionSnapshot, WikiSelectionStatus,
    WikiSelectionTask, WikiSelectionTaskInput, WikiSelectionTurn,
};
pub use owner::actor::WikiOwnerInput;
pub use ports::{
    WikiFuture, WikiIngestImageCaptionRequest, WikiIngestImageCaptionResponse, WikiIngestLlm,
    WikiIngestLlmDeltaSink, WikiIngestLlmMessage, WikiIngestLlmModelLimits, WikiIngestLlmOptions,
    WikiIngestLlmRequest, WikiIngestLlmResponse, WikiIngestLlmRole, WikiRequestAdmission,
    WikiRequestAdmissionClosed,
};

pub fn wiki_mcp_provider(
    state_dir: &std::path::Path,
) -> Result<impl platform::mcp::ToolProvider + use<>, WikiFailure> {
    adapters::mcp::WikiMcpFacade::open(state_dir)
}

#[derive(Clone)]
pub struct WikiModule {
    handle: WikiHandle,
}

impl WikiModule {
    fn new(handle: WikiHandle) -> Self {
        Self { handle }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.handle = self.handle.with_call_recorder(recorder);
        self
    }

    pub fn handle(&self) -> &WikiHandle {
        &self.handle
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(self.loopback_descriptor(verifier)),
            Some(CapabilityDescriptorProvider::new(
                capability::listed,
                capability::describe,
            )),
        )
    }

    fn loopback_descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    ) -> platform::loopback::ModuleDescriptor {
        adapters::loopback::descriptor(adapters::loopback::Dependencies::new(
            verifier,
            self.handle.clone(),
        ))
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: WikiOwnerInput,
) -> Result<(WikiModule, OwnedTask<()>), WikiFailure> {
    let (source_watch_control, source_watch_receiver) =
        owner::source_watcher::SourceWatchControl::channel();
    let owner = WikiOwner::new(input, source_watch_control.clone())?;
    let shared = owner.shared();
    let (handle, mut owner_task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(32, WikiOwner::lane_retention()),
    );
    let handle = WikiHandle::new(handle, shared.clone());
    let mut source_watch_task =
        owner::source_watcher::spawn(handle.clone(), source_watch_control, source_watch_receiver);
    let workflow_handle = handle.clone();
    let (task, shutdown) = OwnedTask::spawn(|cancellation| async move {
        let failed = tokio::select! {
            _ = cancellation.cancelled() => {
                source_watch_task.cancel();
                shared.missing_pages.cancel_all();
                shared.review_sweeps.close();
                shared.selection.close();
                shared.dedup.shutdown().await;
                workflow_handle.drain_call_workflows().await;
                let watcher_failed = call::report_task_exit(source_watch_task.join().await);
                let owner_failed = call::report_task_exit(owner_task.drain_and_join().await);
                watcher_failed || owner_failed
            }
            result = &mut source_watch_task => {
                let watcher_failed = call::report_task_exit(result);
                shared.missing_pages.cancel_all();
                shared.review_sweeps.close();
                shared.selection.close();
                shared.dedup.shutdown().await;
                workflow_handle.drain_call_workflows().await;
                let owner_failed = call::report_task_exit(owner_task.drain_and_join().await);
                watcher_failed || owner_failed
            }
            result = &mut owner_task => {
                let owner_failed = call::report_task_exit(result);
                source_watch_task.cancel();
                shared.missing_pages.cancel_all();
                shared.review_sweeps.close();
                shared.selection.close();
                shared.dedup.shutdown().await;
                workflow_handle.drain_call_workflows().await;
                let watcher_failed = call::report_task_exit(source_watch_task.join().await);
                watcher_failed || owner_failed
            }
        };
        assert!(!failed, "Wiki managed owner shutdown failed");
    });
    Ok((WikiModule::new(handle.with_shutdown(shutdown)), task))
}
