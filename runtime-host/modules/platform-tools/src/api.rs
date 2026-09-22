use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use crate::{
    PlatformToolsOutcome,
    application::commands::{PlatformToolsCommand, PlatformToolsQuery},
};

#[derive(Clone)]
pub struct PlatformToolsModule {
    owner: OwnerRuntimeHandle<PlatformToolsCommand, PlatformToolsQuery>,
}

impl PlatformToolsModule {
    pub(crate) fn new(owner: OwnerRuntimeHandle<PlatformToolsCommand, PlatformToolsQuery>) -> Self {
        Self { owner }
    }

    pub async fn platform_tools(&self) -> PlatformToolsOutcome {
        self.request_query(|reply| PlatformToolsQuery::List { reply })
            .await
            .unwrap_or(PlatformToolsOutcome::Unavailable)
    }

    async fn request_query<T>(
        &self,
        query: impl FnOnce(oneshot::Sender<T>) -> PlatformToolsQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner.send_query(query(reply)).await.map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
