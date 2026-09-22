use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use crate::{
    application::commands::{TaskCommand as OwnerCommand, TaskQuery},
    domain::model::{TaskCommand, TaskOutcome},
};

#[derive(Clone)]
pub struct TaskHandle {
    owner: OwnerRuntimeHandle<OwnerCommand, TaskQuery>,
}

impl TaskHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<OwnerCommand, TaskQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn task_manager(&self, command: TaskCommand) -> Result<TaskOutcome, ()> {
        self.request_command(|reply| OwnerCommand::Execute { command, reply })
            .await
    }

    async fn request_command<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> OwnerCommand,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(command(reply))
            .await
            .map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
