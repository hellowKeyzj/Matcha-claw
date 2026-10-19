use platform::endpoint::runtime_address::RuntimeScope;
use sessions_module::{
    SessionHandle,
    send::SessionSendOutcome,
    state::{SessionEndpoint, SessionIdentity, SessionProvider},
};
use task_manager::{
    SessionTarget, TaskDelivery, TaskFailure, TaskFailureCode, TaskFailureStage, TaskFuture,
    TaskSessionPreparation,
};

pub(in crate::composition::host) struct TaskSessions {
    sessions: SessionHandle,
}

impl TaskSessions {
    pub(in crate::composition::host) fn new(sessions: SessionHandle) -> Self {
        Self { sessions }
    }
}

impl TaskSessionPreparation for TaskSessions {
    fn prepare<'a>(&'a self, target: &'a SessionTarget) -> TaskFuture<'a, Result<(), TaskFailure>> {
        Box::pin(async move {
            let RuntimeScope::Session(identity) = target.scope() else {
                return Err(failure(
                    TaskFailureStage::SessionLookup,
                    TaskFailureCode::InvalidIdentity,
                ));
            };
            if identity.endpoint().runtime_adapter_id() == "openclaw" {
                return Ok(());
            }
            if identity.endpoint()
                != &runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint()
            {
                return Err(failure(
                    TaskFailureStage::SessionLookup,
                    TaskFailureCode::InvalidIdentity,
                ));
            }
            let identity = SessionIdentity::with_endpoint(
                identity.session_key(),
                SessionEndpoint {
                    kind: "native-runtime".to_owned(),
                    runtime_adapter_id: SessionProvider::MatchaAgent,
                    runtime_instance_id: identity.endpoint().runtime_instance_id().to_owned(),
                },
                identity.agent_id().to_owned(),
            )
            .map_err(|_| {
                failure(
                    TaskFailureStage::SessionLookup,
                    TaskFailureCode::InvalidIdentity,
                )
            })?;
            self.sessions
                .prepare_session_model_runtime(&identity)
                .await
                .map_err(|outcome| {
                    let code = match outcome {
                        SessionSendOutcome::Rejected => TaskFailureCode::RequestRejected,
                        SessionSendOutcome::Unavailable => TaskFailureCode::RuntimeNotReady,
                        SessionSendOutcome::Unsupported => TaskFailureCode::Unsupported,
                        SessionSendOutcome::Unknown => TaskFailureCode::RemoteError,
                        SessionSendOutcome::Queued { .. }
                        | SessionSendOutcome::Succeeded { .. } => TaskFailureCode::Protocol,
                    };
                    failure(TaskFailureStage::Runtime, code)
                })
        })
    }
}

fn failure(stage: TaskFailureStage, code: TaskFailureCode) -> TaskFailure {
    TaskFailure {
        delivery: Some(TaskDelivery::NotSent),
        ..TaskFailure::new(stage, code)
    }
}
