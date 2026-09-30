use foundation::execution::OwnerRuntimeHandle;
use platform::call::{CallRecorder, CallStatus};
use tokio::sync::oneshot;

use crate::{
    application::{
        call::{CallFailure, TaskCall, TaskCallDetail, command_name, record_error},
        commands::{TaskCommand as OwnerCommand, TaskQuery},
    },
    domain::model::{TaskCommand, TaskOutcome},
};

#[derive(Clone)]
pub struct TaskHandle {
    owner: OwnerRuntimeHandle<OwnerCommand, TaskQuery>,
    recorder: Option<CallRecorder>,
}

impl TaskHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<OwnerCommand, TaskQuery>) -> Self {
        Self {
            owner,
            recorder: None,
        }
    }

    pub(crate) fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    pub(crate) async fn task_manager(&self, command: TaskCommand) -> Result<TaskOutcome, ()> {
        let detail = TaskCallDetail::from_command(&command);
        let context = if let Some(recorder) = &self.recorder {
            match recorder.begin(command_name(&command), &detail).await {
                Ok(context) => Some(context),
                Err(error) => {
                    record_error(Err(error));
                    None
                }
            }
        } else {
            None
        };
        let call = context.clone().map(|context| TaskCall {
            context,
            detail: detail.clone(),
        });
        let (reply, response) = oneshot::channel();
        if self
            .owner
            .send_command(OwnerCommand::Execute {
                command,
                call,
                reply,
            })
            .await
            .is_err()
        {
            if let Some(context) = context {
                let mut detail = detail;
                detail.failure = Some(CallFailure::OwnerUnavailable);
                record_error(context.finish(CallStatus::Rejected, &detail).await);
            }
            return Err(());
        }
        response.await.map_err(|_| ())
    }
}
