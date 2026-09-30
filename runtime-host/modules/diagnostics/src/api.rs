use foundation::execution::{ObservationSink, OwnerRuntimeHandle};
use platform::call::{CallContext, CallReceipt, CallRecorder, CallStatus};
use tokio::sync::oneshot;

use crate::{
    DiagnosticsArchiveError, DiagnosticsArchiveReceipt,
    application::{
        call::{self, CallFailure, DiagnosticsCallDetail},
        commands::{DiagnosticsCommand, DiagnosticsQuery},
    },
    ports::DiagnosticsArchiveCancellation,
};

#[derive(Clone)]
pub struct DiagnosticsHandle {
    owner: OwnerRuntimeHandle<DiagnosticsCommand, DiagnosticsQuery>,
    recorder: Option<CallRecorder>,
    observation: ObservationSink,
}

impl DiagnosticsHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<DiagnosticsCommand, DiagnosticsQuery>) -> Self {
        Self {
            owner,
            recorder: None,
            observation: ObservationSink::disabled(),
        }
    }

    pub(crate) fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    pub(crate) fn with_observation(mut self, observation: ObservationSink) -> Self {
        self.observation = observation;
        self
    }

    pub(crate) async fn admit_archive(
        &self,
        cancellation: DiagnosticsArchiveCancellation,
    ) -> Result<CallReceipt, DiagnosticsArchiveError> {
        let detail = DiagnosticsCallDetail::collect();
        let call = self
            .begin("diagnostics.archive", &detail)
            .await?
            .ok_or(DiagnosticsArchiveError::OutputUnavailable)?;
        let (reply, _) = oneshot::channel();
        if self
            .owner
            .try_send_command(DiagnosticsCommand::CollectArchive {
                call: Some(call.clone()),
                observation: self.observation.clone(),
                cancellation,
                reply,
            })
            .is_err()
        {
            call::finish(
                Some(&call),
                CallStatus::Rejected,
                &detail.failed(CallFailure::OwnerUnavailable),
            )
            .await;
            return Err(DiagnosticsArchiveError::OutputUnavailable);
        }
        call.accepted().await.map_err(|error| {
            eprintln!(
                "[diagnostics:call] admission record failed call_id={} error={error}",
                call.id().as_str()
            );
            DiagnosticsArchiveError::OutputUnavailable
        })
    }

    pub(crate) async fn collect_archive(
        &self,
        cancellation: DiagnosticsArchiveCancellation,
    ) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
        let detail = DiagnosticsCallDetail::collect();
        let call = self.begin("diagnostics.archive", &detail).await?;
        let (reply, response) = oneshot::channel();
        if self
            .owner
            .send_command(DiagnosticsCommand::CollectArchive {
                call: call.clone(),
                observation: self.observation.clone(),
                cancellation,
                reply,
            })
            .await
            .is_err()
        {
            call::finish(
                call.as_ref(),
                CallStatus::Rejected,
                &detail.failed(CallFailure::OwnerUnavailable),
            )
            .await;
            return Err(DiagnosticsArchiveError::OutputUnavailable);
        }
        Self::accepted(call.as_ref()).await;
        response
            .await
            .unwrap_or(Err(DiagnosticsArchiveError::OutputUnavailable))
    }

    pub(crate) async fn download_archive(
        &self,
        archive_id: String,
    ) -> Result<Vec<u8>, DiagnosticsArchiveError> {
        let detail = DiagnosticsCallDetail::download(&archive_id);
        let call = self.begin("diagnostics.archive.download", &detail).await?;
        let (reply, response) = oneshot::channel();
        if self
            .owner
            .send_query(DiagnosticsQuery::DownloadArchive {
                call: call.clone(),
                archive_id,
                reply,
            })
            .await
            .is_err()
        {
            call::finish(
                call.as_ref(),
                CallStatus::Rejected,
                &detail.failed(CallFailure::OwnerUnavailable),
            )
            .await;
            return Err(DiagnosticsArchiveError::OutputUnavailable);
        }
        Self::accepted(call.as_ref()).await;
        response
            .await
            .unwrap_or(Err(DiagnosticsArchiveError::OutputUnavailable))
    }

    async fn begin(
        &self,
        command: &'static str,
        detail: &DiagnosticsCallDetail,
    ) -> Result<Option<CallContext<DiagnosticsCallDetail>>, DiagnosticsArchiveError> {
        match &self.recorder {
            Some(recorder) => recorder
                .begin(command, detail)
                .await
                .map(Some)
                .map_err(|error| {
                    eprintln!("[diagnostics:call] begin failed command={command} error={error}");
                    DiagnosticsArchiveError::OutputUnavailable
                }),
            None => Ok(None),
        }
    }

    async fn accepted(call: Option<&CallContext<DiagnosticsCallDetail>>) {
        if let Some(call) = call {
            if let Err(error) = call.accepted().await {
                eprintln!(
                    "[diagnostics:call] admission record failed call_id={} error={error}",
                    call.id().as_str()
                );
            }
        }
    }
}
