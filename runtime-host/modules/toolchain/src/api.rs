use std::sync::Arc;

use foundation::execution::OwnerRuntimeHandle;
use futures_util::FutureExt;
use platform::call::{CallContext, CallReceipt, CallRecorder, CallStatus};
use tokio::sync::oneshot;

use crate::{
    PrepareOutcome, ToolchainRequestAdmissionClosed, ToolchainStatus,
    application::{
        call::{self, CallFailure, ToolchainCallDetail},
        commands::{ToolchainCommand, ToolchainQuery},
    },
};

#[derive(Clone)]
pub struct ToolchainModule {
    owner: OwnerRuntimeHandle<ToolchainCommand, ToolchainQuery>,
    admission: Arc<dyn crate::ToolchainRequestAdmission>,
    recorder: Option<CallRecorder>,
}

impl ToolchainModule {
    pub(crate) fn new(
        owner: OwnerRuntimeHandle<ToolchainCommand, ToolchainQuery>,
        admission: Arc<dyn crate::ToolchainRequestAdmission>,
    ) -> Self {
        Self {
            owner,
            admission,
            recorder: None,
        }
    }

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    pub async fn status(
        &self,
    ) -> Result<Result<ToolchainStatus, ToolchainRequestAdmissionClosed>, ()> {
        let detail = ToolchainCallDetail::status();
        let call = self.begin("toolchain.status", &detail).await?;
        let (reply, response) = oneshot::channel();
        if self
            .owner
            .send_query(ToolchainQuery::Status {
                call: call.clone(),
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
            return Err(());
        }
        response.await.map_err(|_| ())
    }

    pub async fn prepare(
        &self,
    ) -> Result<Result<PrepareOutcome, ToolchainRequestAdmissionClosed>, ()> {
        let detail = ToolchainCallDetail::prepare();
        let call = self.begin("toolchain.prepare", &detail).await?;
        let (reply, response) = oneshot::channel();
        if self
            .owner
            .send_command(ToolchainCommand::Prepare {
                call: call.clone(),
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
            return Err(());
        }
        response.await.map_err(|_| ())
    }

    pub async fn admit_prepare(&self) -> Result<CallReceipt, ()> {
        let recorder = self.recorder.as_ref().ok_or(())?;
        let detail = ToolchainCallDetail::prepare();
        let context = recorder
            .begin("toolchain.prepare", &detail)
            .await
            .map_err(|error| {
                eprintln!("[toolchain:call] begin failed command=toolchain.prepare error={error}");
            })?;
        if self.admission.admit_toolchain_request().is_err() {
            call::finish(
                Some(&context),
                CallStatus::Rejected,
                &detail.failed(CallFailure::AdmissionClosed),
            )
            .await;
            return Err(());
        }
        let permit = match self.owner.try_reserve() {
            Ok(permit) => permit,
            Err(error) => {
                let failure = match error {
                    foundation::execution::OwnerRuntimeSendError::Full => CallFailure::QueueFull,
                    foundation::execution::OwnerRuntimeSendError::Closed => {
                        CallFailure::OwnerUnavailable
                    }
                };
                call::finish(
                    Some(&context),
                    CallStatus::Rejected,
                    &detail.failed(failure),
                )
                .await;
                return Err(());
            }
        };
        let admission_context = context.clone();
        let accepted: platform::call::CallFuture<CallReceipt> =
            Box::pin(async move { admission_context.accepted().await });
        let accepted = accepted.shared();
        if permit
            .send(ToolchainCommand::AdmitPrepare {
                call: context.clone(),
                accepted: accepted.clone(),
            })
            .is_err()
        {
            call::finish(
                Some(&context),
                CallStatus::Rejected,
                &detail.failed(CallFailure::OwnerUnavailable),
            )
            .await;
            return Err(());
        }
        accepted.await.map_err(|_| ())
    }

    async fn begin(
        &self,
        command: &'static str,
        detail: &ToolchainCallDetail,
    ) -> Result<Option<CallContext<ToolchainCallDetail>>, ()> {
        match &self.recorder {
            Some(recorder) => recorder
                .begin(command, detail)
                .await
                .map(Some)
                .map_err(|error| {
                    eprintln!("[toolchain:call] begin failed command={command} error={error}");
                }),
            None => Ok(None),
        }
    }
}
