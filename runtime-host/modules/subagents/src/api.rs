use std::sync::Arc;
use foundation::execution::OwnerRuntimeHandle;
use platform::call::{CallId, CallReceipt, CallRecorder, CallStatus};
use tokio::sync::{OnceCell, oneshot};

use crate::{
    application::commands::{SubagentCommandEnvelope, SubagentQuery},
    domain::model::{Command, Outcome},
    projection::call::{SubagentCallDetail, command_name},
};

#[derive(Clone)]
pub struct SubagentHandle {
    owner: OwnerRuntimeHandle<SubagentCommandEnvelope, SubagentQuery>,
    recorder: Option<CallRecorder>,
    results: crate::application::results::MutationResults,
}

impl SubagentHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<SubagentCommandEnvelope, SubagentQuery>, results: crate::application::results::MutationResults) -> Self {
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

    pub(crate) async fn admit(&self, command: Command, principal: String) -> Result<CallReceipt, ()> {
        use crate::application::results::{ResultSubject, is_background_mutation};
        if !is_background_mutation(&command) { return Err(()); }
        let mut detail = SubagentCallDetail::from_command(&command);
        let call = self.recorder.as_ref().ok_or(())?
            .begin(command_name(&command), &detail).await.map_err(|_| ())?;
        let id = call.id().clone();
        if self.results.reserve(id.clone(), ResultSubject::from_command(&command, principal)).is_err() {
            detail.finish(&Outcome::Unavailable);
            let _ = call.finish(CallStatus::Rejected, &detail).await;
            return Err(());
        }
        let admission = Arc::new(OnceCell::new());
        let (reply, _) = oneshot::channel();
        if self.owner.try_send_command(SubagentCommandEnvelope::Execute {
            command, call: Some(call.clone()), detail: detail.clone(), admission: Some(admission.clone()), reply,
        }).is_err() {
            self.results.remove(&id);
            detail.finish(&Outcome::Unavailable);
            let _ = call.finish(CallStatus::Rejected, &detail).await;
            return Err(());
        }
        admission.get_or_init(|| call.accepted()).await.clone().map_err(|_| ())
    }

    pub(crate) fn read_result(&self, id: &CallId, subject: &crate::application::results::ResultSubject) -> crate::application::results::ResultRead {
        self.results.read(id, subject)
    }

    pub async fn subagents(&self, command: Command) -> Result<Outcome, ()> {
        let mut detail = SubagentCallDetail::from_command(&command);
        let call = match &self.recorder {
            Some(recorder) => Some(
                recorder
                    .begin(command_name(&command), &detail)
                    .await
                    .map_err(|_| ())?,
            ),
            None => None,
        };
        let (reply, response) = oneshot::channel();
        if self
            .owner
            .send_command(SubagentCommandEnvelope::Execute {
                command,
                call: call.clone(),
                detail: detail.clone(),
                admission: None,
                reply,
            })
            .await
            .is_err()
        {
            if let Some(call) = call {
                detail.finish(&Outcome::Unavailable);
                if let Err(error) = call.finish(CallStatus::Rejected, &detail).await {
                    eprintln!("subagents call-log enqueue rejection: {error}");
                }
            }
            return Err(());
        }
        response.await.map_err(|_| ())
    }
}
