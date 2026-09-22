use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use crate::{
    application::commands::{UsageCommand, UsageQuery},
    domain::model::{UsageEntry, UsageReadError},
};

#[derive(Clone)]
pub struct UsageHandle {
    owner: OwnerRuntimeHandle<UsageCommand, UsageQuery>,
}

impl UsageHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<UsageCommand, UsageQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn recent(&self, limit: usize) -> Result<Vec<UsageEntry>, UsageReadError> {
        self.request_query(|reply| UsageQuery::Recent { limit, reply })
            .await
            .unwrap_or(Err(UsageReadError::Unavailable))
    }

    pub(crate) async fn session_timeseries(
        &self,
        agent_id: String,
        session_id: String,
    ) -> Result<Vec<UsageEntry>, UsageReadError> {
        self.request_query(|reply| UsageQuery::SessionTimeseries {
            agent_id,
            session_id,
            reply,
        })
        .await
        .unwrap_or(Err(UsageReadError::Unavailable))
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
