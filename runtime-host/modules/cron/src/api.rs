use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use crate::{
    application::commands::{CronCommand, CronQuery},
    model::{
        CronCreateCommand, CronDeleteCommand, CronDeleteOutcome, CronHistoryCommand,
        CronHistoryOutcome, CronJobMutationOutcome, CronListOutcome, CronTriggerResult,
        CronUpdateCommand,
    },
    ports::CronRequestAdmissionClosed,
};

#[derive(Clone)]
pub struct CronHandle {
    owner: OwnerRuntimeHandle<CronCommand, CronQuery>,
}

impl CronHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<CronCommand, CronQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn list(&self) -> Result<CronListOutcome, ()> {
        self.request_query(|reply| CronQuery::List { reply }).await
    }

    pub(crate) async fn load_history(
        &self,
        command: CronHistoryCommand,
    ) -> Result<CronHistoryOutcome, ()> {
        self.request_query(|reply| CronQuery::LoadHistory { command, reply })
            .await
    }

    pub(crate) async fn create(
        &self,
        command: CronCreateCommand,
    ) -> Result<CronJobMutationOutcome, ()> {
        self.request_command(|reply| CronCommand::Create { command, reply })
            .await
    }

    pub(crate) async fn update(
        &self,
        command: CronUpdateCommand,
    ) -> Result<CronJobMutationOutcome, ()> {
        self.request_command(|reply| CronCommand::Update { command, reply })
            .await
    }

    pub(crate) async fn delete(&self, command: CronDeleteCommand) -> Result<CronDeleteOutcome, ()> {
        self.request_command(|reply| CronCommand::Delete { command, reply })
            .await
    }

    pub(crate) async fn trigger(
        &self,
        job_id: String,
    ) -> Result<Result<CronTriggerResult, CronRequestAdmissionClosed>, ()> {
        self.request_command(|reply| CronCommand::Trigger { job_id, reply })
            .await
    }

    pub(crate) async fn cancel_operations(&self) -> Result<(), ()> {
        self.request_command(|reply| CronCommand::CancelOperations { reply })
            .await
    }

    async fn request_command<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> CronCommand,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(command(reply))
            .await
            .map_err(|_| ())?;
        response.await.map_err(|_| ())
    }

    async fn request_query<T>(
        &self,
        query: impl FnOnce(oneshot::Sender<T>) -> CronQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner.send_query(query(reply)).await.map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
