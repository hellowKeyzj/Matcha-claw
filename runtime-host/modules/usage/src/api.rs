use foundation::execution::OwnerRuntimeHandle;
use platform::call::{CallContext, CallRecorder, CallStatus};
use tokio::sync::oneshot;

use crate::{
    application::{
        call::{self, CallFailure, UsageCallDetail},
        commands::{UsageCommand, UsageQuery},
    },
    domain::model::{UsageEntry, UsageReadError},
};

#[derive(Clone)]
pub struct UsageHandle {
    owner: OwnerRuntimeHandle<UsageCommand, UsageQuery>,
    recorder: Option<CallRecorder>,
}

impl UsageHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<UsageCommand, UsageQuery>) -> Self {
        Self {
            owner,
            recorder: None,
        }
    }

    pub(crate) fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    pub(crate) async fn recent(&self, limit: usize) -> Result<Vec<UsageEntry>, UsageReadError> {
        self.recorded_query(
            "usage.recent",
            UsageCallDetail::recent(limit),
            |call, reply| UsageQuery::Recent { limit, call, reply },
        )
        .await
    }

    pub(crate) async fn session_timeseries(
        &self,
        agent_id: String,
        session_id: String,
    ) -> Result<Vec<UsageEntry>, UsageReadError> {
        self.recorded_query(
            "usage.sessionTimeseries",
            UsageCallDetail::session_timeseries(),
            |call, reply| UsageQuery::SessionTimeseries {
                agent_id,
                session_id,
                call,
                reply,
            },
        )
        .await
    }

    async fn recorded_query(
        &self,
        command: &'static str,
        detail: UsageCallDetail,
        query: impl FnOnce(
            Option<CallContext<UsageCallDetail>>,
            oneshot::Sender<Result<Vec<UsageEntry>, UsageReadError>>,
        ) -> UsageQuery,
    ) -> Result<Vec<UsageEntry>, UsageReadError> {
        let call = match &self.recorder {
            Some(recorder) => Some(recorder.begin(command, &detail).await.map_err(|error| {
                eprintln!("[usage:call] begin failed command={command} error={error}");
                UsageReadError::Unavailable
            })?),
            None => None,
        };
        let (reply, response) = oneshot::channel();
        if self
            .owner
            .send_query(query(call.clone(), reply))
            .await
            .is_err()
        {
            call::finish(
                call.as_ref(),
                CallStatus::Rejected,
                &detail.failed(CallFailure::OwnerUnavailable),
            )
            .await;
            return Err(UsageReadError::Unavailable);
        }
        response.await.unwrap_or(Err(UsageReadError::Unavailable))
    }

    pub(crate) async fn default_limit(&self) -> usize {
        self.request_query(|reply| UsageQuery::DefaultLimit { reply })
            .await
            .unwrap_or(100)
    }

    pub(crate) async fn max_limit(&self) -> usize {
        self.request_query(|reply| UsageQuery::MaxLimit { reply })
            .await
            .unwrap_or(1_000)
    }

    async fn request_query<T>(
        &self,
        query: impl FnOnce(oneshot::Sender<T>) -> UsageQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner.send_query(query(reply)).await.map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
