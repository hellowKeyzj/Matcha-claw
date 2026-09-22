use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use crate::{
    application::commands::{SubagentCommandEnvelope, SubagentQuery},
    domain::model::{Command, Outcome},
};

#[derive(Clone)]
pub struct SubagentHandle {
    owner: OwnerRuntimeHandle<SubagentCommandEnvelope, SubagentQuery>,
}

impl SubagentHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<SubagentCommandEnvelope, SubagentQuery>) -> Self {
        Self { owner }
    }

    pub async fn subagents(&self, command: Command) -> Result<Outcome, ()> {
        self.request_command(|reply| SubagentCommandEnvelope::Execute { command, reply })
            .await
    }

    async fn request_command<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> SubagentCommandEnvelope,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(command(reply))
            .await
            .map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
