use foundation::execution::OwnerRuntimeHandle;
use platform::call::{CallId, CallReceipt, CallRecorder, CallStatus};
use tokio::sync::oneshot;

use crate::{
    application::{
        commands::{CronCommand, CronQuery, MutationCommand},
        results::{MutationResults, ResultRead, ResultSubject},
    },
    call::{CronCall, CronCallDetail, Outcome},
    model::{CronHistoryCommand, CronHistoryOutcome, CronListOutcome, CronTriggerResult},
    ports::CronRequestAdmissionClosed,
};

#[derive(Clone)]
pub struct CronHandle {
    owner: OwnerRuntimeHandle<CronCommand, CronQuery>,
    recorder: Option<CallRecorder>,
    results: MutationResults,
}

impl CronHandle {
    pub(crate) fn new(
        owner: OwnerRuntimeHandle<CronCommand, CronQuery>,
        results: MutationResults,
    ) -> Self {
        Self {
            owner,
            recorder: None,
            results,
        }
    }

    pub(crate) fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    pub(crate) async fn list(&self) -> Result<CronListOutcome, ()> {
        let call = CronCall::begin(self.recorder.as_ref(), "list", CronCallDetail::default()).await;
        self.request_query(call.clone(), |reply| CronQuery::List { call, reply })
            .await
    }

    pub(crate) async fn load_history(
        &self,
        command: CronHistoryCommand,
    ) -> Result<CronHistoryOutcome, ()> {
        let mut detail = CronCallDetail::job(command.job_id());
        detail.history_limit = Some(command.limit());
        let call = CronCall::begin(self.recorder.as_ref(), "history", detail).await;
        self.request_query(call.clone(), |reply| CronQuery::LoadHistory {
            command,
            call,
            reply,
        })
        .await
    }

    pub(crate) async fn admit(
        &self,
        command: MutationCommand,
        principal: String,
    ) -> Result<CallReceipt, ()> {
        let mut call = CronCall::begin(
            Some(self.recorder.as_ref().ok_or(())?),
            command.kind().command(),
            command.detail(),
        )
        .await
        .ok_or(())?;
        let id = call.id().clone();
        let subject = ResultSubject {
            principal,
            command: command.kind(),
            job_id: command.job_id().map(str::to_owned),
        };
        if self.results.reserve(id.clone(), subject).is_err() {
            call.finish(CallStatus::Rejected, Outcome::Unavailable)
                .await;
            return Err(());
        }
        if self
            .owner
            .try_send_command(CronCommand::Mutate {
                command,
                call: call.clone(),
            })
            .is_err()
        {
            self.results.remove(&id);
            call.finish(CallStatus::Rejected, Outcome::Unavailable)
                .await;
            return Err(());
        }
        call.accepted().await.map_err(|_| ())
    }

    pub(crate) fn read_result(&self, id: &CallId, subject: &ResultSubject) -> ResultRead {
        self.results.read(id, subject)
    }

    pub(crate) async fn trigger(
        &self,
        job_id: String,
    ) -> Result<Result<CronTriggerResult, CronRequestAdmissionClosed>, ()> {
        let call = CronCall::begin(
            self.recorder.as_ref(),
            "trigger",
            CronCallDetail::job(&job_id),
        )
        .await;
        self.request_command(call.clone(), |reply| CronCommand::Trigger {
            job_id,
            call,
            reply,
        })
        .await
    }

    pub(crate) async fn cancel_operations(&self) -> Result<(), ()> {
        self.request_command(None, |reply| CronCommand::CancelOperations { reply })
            .await
    }

    async fn request_command<T>(
        &self,
        mut call: Option<CronCall>,
        command: impl FnOnce(oneshot::Sender<T>) -> CronCommand,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        if self.owner.send_command(command(reply)).await.is_err() {
            if let Some(call) = &mut call {
                call.finish(CallStatus::Rejected, Outcome::Unavailable)
                    .await;
            }
            return Err(());
        }
        response.await.map_err(|_| ())
    }

    async fn request_query<T>(
        &self,
        mut call: Option<CronCall>,
        query: impl FnOnce(oneshot::Sender<T>) -> CronQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        if self.owner.send_query(query(reply)).await.is_err() {
            if let Some(call) = &mut call {
                call.finish(CallStatus::Rejected, Outcome::Unavailable)
                    .await;
            }
            return Err(());
        }
        response.await.map_err(|_| ())
    }
}
