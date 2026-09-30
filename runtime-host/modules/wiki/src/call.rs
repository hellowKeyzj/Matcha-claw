use std::{future::Future, sync::Arc};

use foundation::execution::OwnedTask;
use platform::call::{CallContext, CallDetail, CallReceipt, CallRecorder, CallStatus};
use serde::Serialize;
use tokio::sync::{Mutex, OnceCell, oneshot};

use crate::WikiFailure;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiCallDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<WikiCallOperation>,
    outcome: Option<WikiCallOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    counts: Option<Option<WikiCallCounts>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_state: Option<Option<WikiCallTaskState>>,
}

impl WikiCallDetail {
    pub(crate) fn new(operation: WikiCallOperation) -> Self {
        Self {
            operation: Some(operation),
            outcome: None,
            counts: operation.has_counts().then_some(None),
            task_state: operation.is_source_task().then_some(None),
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WikiCallOperation {
    ImportSource,
    ImportFolder,
    RefreshSources,
    EmbedPage,
    RescanSources,
    ApplyGeneratedPages,
    DeleteSource,
    #[serde(rename = "source-task.retry")]
    RetrySourceTask,
    #[serde(rename = "source-task.resume")]
    ResumeSourceTask,
    #[serde(rename = "research.start")]
    StartResearch,
    #[serde(rename = "research-task.rerun")]
    RerunResearch,
    #[serde(rename = "history.restore")]
    RestoreHistory,
    #[serde(rename = "history.clear")]
    ClearHistory,
    #[serde(rename = "project.export-archive")]
    ExportArchive,
    #[serde(rename = "project.import-archive")]
    ImportArchive,
    RebuildIndex,
    #[serde(rename = "qa.ask")]
    QaAsk,
    #[serde(rename = "qa.save")]
    QaSave,
    #[serde(rename = "lint.run")]
    RunLint,
    #[serde(rename = "lint.fix")]
    FixLint,
    #[serde(rename = "lint.review")]
    ReviewLint,
    #[serde(rename = "lint.delete")]
    DeleteLint,
    #[serde(rename = "embedding.reindex")]
    Reindex,
    #[serde(rename = "graph.insights.research-input")]
    GraphInsightResearchInput,
}

impl WikiCallOperation {
    pub(crate) const fn command(self) -> &'static str {
        match self {
            Self::ImportSource => "import-source",
            Self::ImportFolder => "import-folder",
            Self::RefreshSources => "refresh-sources",
            Self::EmbedPage => "embed-page",
            Self::RescanSources => "rescan-sources",
            Self::ApplyGeneratedPages => "apply-generated-pages",
            Self::DeleteSource => "delete-source",
            Self::RetrySourceTask => "source-task.retry",
            Self::ResumeSourceTask => "source-task.resume",
            Self::StartResearch => "research.start",
            Self::RerunResearch => "research-task.rerun",
            Self::RestoreHistory => "history.restore",
            Self::ClearHistory => "history.clear",
            Self::ExportArchive => "project.export-archive",
            Self::ImportArchive => "project.import-archive",
            Self::RebuildIndex => "rebuild-index",
            Self::QaAsk => "qa.ask",
            Self::QaSave => "qa.save",
            Self::RunLint => "lint.run",
            Self::FixLint => "lint.fix",
            Self::ReviewLint => "lint.review",
            Self::DeleteLint => "lint.delete",
            Self::Reindex => "embedding.reindex",
            Self::GraphInsightResearchInput => "graph.insights.research-input",
        }
    }

    const fn is_source_task(self) -> bool {
        matches!(self, Self::RetrySourceTask | Self::ResumeSourceTask)
    }

    const fn has_counts(self) -> bool {
        matches!(
            self,
            Self::ImportSource
                | Self::ImportFolder
                | Self::RefreshSources
                | Self::ApplyGeneratedPages
                | Self::DeleteSource
                | Self::StartResearch
                | Self::RerunResearch
        )
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(untagged)]
enum WikiCallCounts {
    Sources(WikiSourceCallCounts),
    Research {
        done: usize,
        error: usize,
        saved: usize,
    },
    Written {
        #[serde(rename = "writtenPages")]
        written_pages: usize,
    },
    Deleted {
        #[serde(rename = "deletedPages")]
        deleted_pages: usize,
        #[serde(rename = "updatedPages")]
        updated_pages: usize,
        #[serde(rename = "deletedMedia")]
        deleted_media: usize,
    },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiSourceCallCounts {
    imported: usize,
    skipped: usize,
    deleted: usize,
    moved: usize,
}

impl WikiSourceCallCounts {
    pub(crate) fn import_source(_receipt: &crate::WikiImportSourceReceipt) -> Self {
        Self {
            imported: 1,
            skipped: 0,
            deleted: 0,
            moved: 0,
        }
    }

    pub(crate) fn import_folder(receipt: &crate::WikiImportFolderReceipt) -> Self {
        Self {
            imported: receipt.imported().len(),
            skipped: receipt.skipped().len(),
            deleted: 0,
            moved: 0,
        }
    }

    pub(crate) fn refresh_sources(receipt: &crate::WikiRefreshSourcesReceipt) -> Self {
        Self {
            imported: receipt.imported().len(),
            skipped: receipt.skipped().len(),
            deleted: receipt.deleted().len(),
            moved: receipt.moved().len(),
        }
    }
}

impl CallDetail for WikiCallDetail {
    const MODULE: &'static str = "wiki";
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum WikiCallOutcome {
    Completed,
    Cancelled,
    Rejected,
    Unavailable,
    Failed,
    Incomplete,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WikiCallTaskState {
    Pending,
    Running,
    Done,
    Failed,
    Cancelled,
    Paused,
    Missing,
}

#[derive(Clone)]
pub(crate) enum WikiWorkflowSummary {
    Question,
    Lint,
    Reindex,
    GraphInsightResearchInput,
    Research(crate::research::ResearchCounts),
    Sources(WikiSourceCallCounts),
    SourceTask {
        state: Option<WikiCallTaskState>,
        failure: Option<WikiFailure>,
    },
}

pub(crate) type WikiCallAcceptance = Arc<OnceCell<Result<CallReceipt, WikiFailure>>>;

pub(crate) async fn accepted(
    call: &CallContext<WikiCallDetail>,
    acceptance: &WikiCallAcceptance,
) -> Result<CallReceipt, WikiFailure> {
    acceptance
        .get_or_init(|| async {
            call.accepted().await.map_err(|_| {
                eprintln!("[wiki] call acceptance persistence failed; execution blocked");
                WikiFailure::OwnerUnavailable
            })
        })
        .await
        .clone()
}

pub(crate) struct CallReply<T> {
    sender: oneshot::Sender<Result<T, WikiFailure>>,
    pub(crate) call: Option<CallContext<WikiCallDetail>>,
    pub(crate) operation: Option<WikiCallOperation>,
    pub(crate) acceptance: Option<WikiCallAcceptance>,
    pub(crate) result: Option<crate::call_result::WikiResultReservation>,
}

impl<T> CallReply<T> {
    pub(crate) fn new(sender: oneshot::Sender<Result<T, WikiFailure>>) -> Self {
        Self {
            sender,
            call: None,
            operation: None,
            acceptance: None,
            result: None,
        }
    }

    pub(crate) async fn send(
        self,
        result: Result<T, WikiFailure>,
    ) -> Result<(), Result<T, WikiFailure>> {
        finish_detail(self.call.as_ref(), result.as_ref().err(), self.operation).await;
        self.sender.send(result)
    }
}

impl CallReply<crate::WikiApplyGeneratedPagesReceipt> {
    pub(crate) async fn send_generated(
        self,
        result: Result<crate::WikiApplyGeneratedPagesReceipt, WikiFailure>,
    ) {
        let counts = result.as_ref().ok().map(|receipt| WikiCallCounts::Written {
            written_pages: receipt.written_pages().len(),
        });
        if let (Some(reservation), Ok(receipt)) = (&self.result, &result) {
            reservation.complete(crate::call_result::WikiCallResult::ApplyGeneratedPages(
                receipt.clone(),
            ));
        }
        finish_summary(
            self.call.as_ref(),
            result.as_ref().err(),
            self.operation,
            counts,
        )
        .await;
        let _ = self.sender.send(result);
    }
}

impl CallReply<crate::WikiDeleteSourceReceipt> {
    pub(crate) async fn send_deleted(
        self,
        result: Result<crate::WikiDeleteSourceReceipt, WikiFailure>,
    ) {
        let counts = result.as_ref().ok().map(|receipt| WikiCallCounts::Deleted {
            deleted_pages: receipt.deleted_pages().len(),
            updated_pages: receipt.updated_pages().len(),
            deleted_media: receipt.deleted_media().len(),
        });
        if let (Some(reservation), Ok(receipt)) = (&self.result, &result) {
            reservation.complete(crate::call_result::WikiCallResult::DeleteSource(
                receipt.clone(),
            ));
        }
        finish_summary(
            self.call.as_ref(),
            result.as_ref().err(),
            self.operation,
            counts,
        )
        .await;
        let _ = self.sender.send(result);
    }
}

impl<T> CallReply<T> {
    async fn send_result(
        self,
        result: Result<T, WikiFailure>,
        project: impl FnOnce(&T) -> crate::call_result::WikiCallResult,
    ) {
        if let (Some(reservation), Ok(value)) = (&self.result, &result) {
            reservation.complete(project(value));
        }
        let _ = self.send(result).await;
    }
}

impl CallReply<crate::WikiProjectsReceipt> {
    pub(crate) async fn send_project_imported(
        self,
        result: Result<crate::WikiProjectsReceipt, WikiFailure>,
    ) {
        self.send_result(result, |value| {
            crate::call_result::WikiCallResult::ProjectImport(value.clone())
        })
        .await;
    }
}

impl CallReply<crate::WikiRebuildIndexReceipt> {
    pub(crate) async fn send_index_rebuilt(
        self,
        result: Result<crate::WikiRebuildIndexReceipt, WikiFailure>,
    ) {
        self.send_result(result, |value| {
            crate::call_result::WikiCallResult::RebuildIndex(value.clone())
        })
        .await;
    }
}

impl CallReply<crate::WikiQuestionSaveReceipt> {
    pub(crate) async fn send_qa_saved(
        self,
        result: Result<crate::WikiQuestionSaveReceipt, WikiFailure>,
    ) {
        self.send_result(result, |value| {
            crate::call_result::WikiCallResult::QaSave(value.clone())
        })
        .await;
    }
}

impl CallReply<crate::lint::WikiLintFixReceipt> {
    pub(crate) async fn send_lint_action(
        self,
        result: Result<crate::lint::WikiLintFixReceipt, WikiFailure>,
        action: crate::lint::LintAction,
    ) {
        self.send_result(result, |value| match action {
            crate::lint::LintAction::Fix => {
                crate::call_result::WikiCallResult::LintFix(value.clone())
            }
            crate::lint::LintAction::Review => {
                crate::call_result::WikiCallResult::LintReview(value.clone())
            }
            crate::lint::LintAction::Delete => {
                crate::call_result::WikiCallResult::LintDelete(value.clone())
            }
        })
        .await;
    }
}

pub(crate) async fn begin(
    recorder: Option<&CallRecorder>,
    command: &'static str,
) -> Result<Option<CallContext<WikiCallDetail>>, WikiFailure> {
    match recorder {
        Some(recorder) => recorder
            .begin(command, &WikiCallDetail::default())
            .await
            .map(Some)
            .map_err(|_| WikiFailure::OwnerUnavailable),
        None => Ok(None),
    }
}

pub(crate) async fn running(
    call: Option<&CallContext<WikiCallDetail>>,
    acceptance: Option<&WikiCallAcceptance>,
) -> Result<(), WikiFailure> {
    if let Some(call) = call {
        if let Some(acceptance) = acceptance {
            accepted(call, acceptance).await?;
        } else {
            call.accepted().await.map_err(|_| {
                eprintln!("[wiki] call acceptance persistence failed; execution blocked");
                WikiFailure::OwnerUnavailable
            })?;
        }
        call.running().await.map_err(|_| {
            eprintln!("[wiki] call running persistence failed; execution blocked");
            WikiFailure::OwnerUnavailable
        })?;
    }
    Ok(())
}

pub(crate) async fn finish(
    call: Option<&CallContext<WikiCallDetail>>,
    failure: Option<&WikiFailure>,
) {
    finish_detail(call, failure, None).await;
}

pub(crate) async fn finish_detail(
    call: Option<&CallContext<WikiCallDetail>>,
    failure: Option<&WikiFailure>,
    operation: Option<WikiCallOperation>,
) {
    finish_summary(call, failure, operation, None).await;
}

async fn finish_summary(
    call: Option<&CallContext<WikiCallDetail>>,
    failure: Option<&WikiFailure>,
    operation: Option<WikiCallOperation>,
    counts: Option<WikiCallCounts>,
) {
    let (status, outcome) = completion(failure);
    finish_terminal(
        call,
        status,
        WikiCallDetail {
            operation,
            outcome: Some(outcome),
            counts: operation
                .filter(|operation| operation.has_counts())
                .map(|_| counts),
            task_state: operation
                .filter(|operation| operation.is_source_task())
                .map(|_| None),
        },
    )
    .await;
}

fn completion(failure: Option<&WikiFailure>) -> (CallStatus, WikiCallOutcome) {
    match failure {
        None => (CallStatus::Succeeded, WikiCallOutcome::Completed),
        Some(WikiFailure::Cancelled) => (CallStatus::Failed, WikiCallOutcome::Cancelled),
        Some(WikiFailure::OwnerUnavailable) => (CallStatus::Failed, WikiCallOutcome::Unavailable),
        Some(
            WikiFailure::StateUnavailable { .. }
            | WikiFailure::Io { .. }
            | WikiFailure::IndexUnavailable { .. },
        ) => (CallStatus::Failed, WikiCallOutcome::Failed),
        Some(_) => (CallStatus::Rejected, WikiCallOutcome::Rejected),
    }
}

async fn finish_terminal(
    call: Option<&CallContext<WikiCallDetail>>,
    status: CallStatus,
    detail: WikiCallDetail,
) {
    if let Some(call) = call {
        if call.finish(status, &detail).await.is_err() {
            eprintln!("[wiki] call terminal persistence failed; business result preserved");
        }
    }
}

async fn finish_workflow(
    call: Option<&CallContext<WikiCallDetail>>,
    failure: Option<&WikiFailure>,
    operation: Option<WikiCallOperation>,
    summary: Option<WikiWorkflowSummary>,
) {
    if let Some(WikiWorkflowSummary::Research(counts)) = summary.as_ref() {
        let (status, outcome) = if counts.error > 0 {
            (CallStatus::Failed, WikiCallOutcome::Failed)
        } else {
            completion(failure)
        };
        finish_terminal(
            call,
            status,
            WikiCallDetail {
                operation,
                outcome: Some(outcome),
                counts: Some(Some(WikiCallCounts::Research {
                    done: counts.done,
                    error: counts.error,
                    saved: counts.saved,
                })),
                task_state: None,
            },
        )
        .await;
        return;
    }
    let Some(WikiWorkflowSummary::SourceTask {
        state,
        failure: task_failure,
    }) = summary
    else {
        let counts = match summary {
            Some(WikiWorkflowSummary::Sources(counts)) => Some(WikiCallCounts::Sources(counts)),
            Some(WikiWorkflowSummary::Research(counts)) => Some(WikiCallCounts::Research {
                done: counts.done,
                error: counts.error,
                saved: counts.saved,
            }),
            _ => None,
        };
        finish_summary(call, failure, operation, counts).await;
        return;
    };
    let (status, outcome) = match state {
        Some(WikiCallTaskState::Failed) => (CallStatus::Failed, WikiCallOutcome::Failed),
        Some(WikiCallTaskState::Cancelled) => (CallStatus::Failed, WikiCallOutcome::Cancelled),
        // Import errors survive even when the source task already committed partial files.
        Some(WikiCallTaskState::Done) => completion(task_failure.as_ref().or(failure)),
        None if task_failure.is_some() || failure.is_some() => {
            completion(task_failure.as_ref().or(failure))
        }
        _ => (CallStatus::Unknown, WikiCallOutcome::Incomplete),
    };
    finish_terminal(
        call,
        status,
        WikiCallDetail {
            operation,
            outcome: Some(outcome),
            counts: None,
            task_state: Some(state),
        },
    )
    .await;
}

pub(crate) async fn reject_admission(
    call: &CallContext<WikiCallDetail>,
    operation: WikiCallOperation,
    error: foundation::execution::OwnerRuntimeSendError,
) {
    let (status, outcome) = match error {
        foundation::execution::OwnerRuntimeSendError::Full => {
            (CallStatus::Rejected, WikiCallOutcome::Rejected)
        }
        foundation::execution::OwnerRuntimeSendError::Closed => {
            (CallStatus::Failed, WikiCallOutcome::Unavailable)
        }
    };
    if call
        .finish(
            status,
            &WikiCallDetail {
                operation: Some(operation),
                outcome: Some(outcome),
                counts: operation.has_counts().then_some(None),
                task_state: operation.is_source_task().then_some(None),
            },
        )
        .await
        .is_err()
    {
        eprintln!("[wiki] command admission rejection persistence failed");
    }
}

pub(crate) fn report_task_exit(result: Result<(), tokio::task::JoinError>) -> bool {
    if let Err(error) = result {
        if error.is_panic() {
            eprintln!("[wiki] managed task panicked; completion unconfirmed");
        } else {
            eprintln!("[wiki] managed task join cancelled; completion unconfirmed");
        }
        true
    } else {
        false
    }
}

#[derive(Default)]
pub(crate) struct CallWorkflows {
    state: Mutex<WorkflowState>,
    pub(crate) cancellation: tokio_util::sync::CancellationToken,
}

#[derive(Default)]
struct WorkflowState {
    closed: bool,
    tasks: Vec<OwnedTask<()>>,
}

impl CallWorkflows {
    pub(crate) async fn run<T, F>(
        self: &Arc<Self>,
        recorder: Option<&CallRecorder>,
        command: &'static str,
        workflow: F,
    ) -> Result<T, WikiFailure>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, WikiFailure>> + Send + 'static,
    {
        let call = begin(recorder, command).await?;
        self.enqueue(call, None, None, workflow, |_| None)
            .await?
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit<T, F>(
        self: &Arc<Self>,
        call: CallContext<WikiCallDetail>,
        operation: WikiCallOperation,
        workflow: F,
        summary: fn(&T) -> WikiWorkflowSummary,
    ) -> Result<CallReceipt, WikiFailure>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, WikiFailure>> + Send + 'static,
    {
        let acceptance = Arc::new(OnceCell::new());
        self.enqueue(
            Some(call.clone()),
            Some(operation),
            Some(acceptance.clone()),
            workflow,
            move |receipt| Some(summary(receipt)),
        )
        .await?;
        accepted(&call, &acceptance).await
    }

    pub(crate) async fn enqueue<T, F, S>(
        &self,
        call: Option<CallContext<WikiCallDetail>>,
        operation: Option<WikiCallOperation>,
        acceptance: Option<WikiCallAcceptance>,
        workflow: F,
        summary: S,
    ) -> Result<oneshot::Receiver<Result<T, WikiFailure>>, WikiFailure>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, WikiFailure>> + Send + 'static,
        S: FnOnce(&T) -> Option<WikiWorkflowSummary> + Send + 'static,
    {
        let mut state = self.state.lock().await;
        let mut index = 0;
        while index < state.tasks.len() {
            if state.tasks[index].is_finished() {
                let mut task = state.tasks.swap_remove(index);
                report_task_exit(task.join().await);
            } else {
                index += 1;
            }
        }
        // Only bounded orchestration is retained here; stage/parse/commit keep their original business lanes.
        if state.closed || state.tasks.len() == 32 {
            finish_detail(
                call.as_ref(),
                Some(&WikiFailure::OwnerUnavailable),
                operation,
            )
            .await;
            return Err(WikiFailure::OwnerUnavailable);
        }
        let (reply, result) = oneshot::channel();
        let (task, _) = OwnedTask::spawn(move |_| async move {
            let result = match running(call.as_ref(), acceptance.as_ref()).await {
                Ok(()) => workflow.await,
                Err(error) => Err(error),
            };
            let summary = result.as_ref().ok().and_then(summary);
            finish_workflow(call.as_ref(), result.as_ref().err(), operation, summary).await;
            let _ = reply.send(result);
        });
        state.tasks.push(task);
        Ok(result)
    }

    pub(crate) async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        state.closed = true;
        self.cancellation.cancel();
        // Drain, rather than abandon a staged source or interrupt an in-flight commit.
        for task in &mut state.tasks {
            report_task_exit(task.join().await);
        }
        state.tasks.clear();
    }
}
