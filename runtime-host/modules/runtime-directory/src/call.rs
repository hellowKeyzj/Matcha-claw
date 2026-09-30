use platform::{
    call::{CallContext, CallDetail, CallLogError, CallRecorder, CallStatus},
    endpoint::runtime_address::RuntimeEndpoint,
};
use serde::Serialize;

use crate::{
    RuntimeControlLifecycle, RuntimeControlLifecycleError, RuntimeControlLifecycleStatus,
    RuntimeDriverIdentity, control_loopback::RuntimeControlOperation,
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryCallDetail {
    pub count: Option<usize>,
    pub result: Option<RuntimeControlCallResult>,
}

impl CallDetail for DirectoryCallDetail {
    const MODULE: &'static str = "runtime-directory";
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeControlCallDetail {
    pub endpoint: Option<RuntimeEndpoint>,
    pub lifecycle: Option<RuntimeControlLifecycle>,
    pub failure: Option<crate::RuntimeControlLifecycleFailure>,
    pub startup_diagnostic: Option<crate::RuntimeControlStartupDiagnostic>,
    pub error: Option<RuntimeControlLifecycleError>,
    pub result: Option<RuntimeControlCallResult>,
    pub count: Option<usize>,
    pub ready: Option<bool>,
    pub healthy: Option<bool>,
}

impl CallDetail for RuntimeControlCallDetail {
    const MODULE: &'static str = "runtime-control";
}

pub type RuntimeControlCallContext = CallContext<RuntimeControlCallDetail>;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeControlCallResult {
    Succeeded,
    Unsupported,
    Unavailable,
    Failed,
    Unknown,
}

impl RuntimeControlCallDetail {
    pub fn new(endpoint: &RuntimeEndpoint) -> Self {
        Self {
            endpoint: [
                RuntimeDriverIdentity::open_claw(),
                RuntimeDriverIdentity::matcha_agent(),
            ]
            .into_iter()
            .find(|identity| identity.endpoint() == *endpoint)
            .map(RuntimeDriverIdentity::endpoint),
            ..Self::default()
        }
    }

    pub fn lifecycle_result(
        endpoint: &RuntimeEndpoint,
        operation: RuntimeControlOperation,
        result: &Result<RuntimeControlLifecycleStatus, RuntimeControlLifecycleError>,
    ) -> (CallStatus, Self) {
        let mut detail = Self::new(endpoint);
        detail.error = result.as_ref().err().copied();
        let (status, result) = match result {
            Ok(observation) => {
                detail.lifecycle = Some(observation.lifecycle);
                detail.failure = observation.failure;
                detail.startup_diagnostic = observation.startup_diagnostic;
                if operation == RuntimeControlOperation::LifecycleStatus {
                    (CallStatus::Succeeded, RuntimeControlCallResult::Succeeded)
                } else if observation.lifecycle == RuntimeControlLifecycle::Failed {
                    (CallStatus::Failed, RuntimeControlCallResult::Failed)
                } else if matches!(
                    (operation, observation.lifecycle),
                    (
                        RuntimeControlOperation::LifecycleStart
                            | RuntimeControlOperation::LifecycleRestart,
                        RuntimeControlLifecycle::Running
                    ) | (
                        RuntimeControlOperation::LifecycleStop,
                        RuntimeControlLifecycle::Idle | RuntimeControlLifecycle::ShutDown
                    )
                ) {
                    (CallStatus::Succeeded, RuntimeControlCallResult::Succeeded)
                } else {
                    // A returned lifecycle snapshot is not proof that the requested effect settled.
                    (CallStatus::Unknown, RuntimeControlCallResult::Unknown)
                }
            }
            Err(RuntimeControlLifecycleError::Unsupported) => {
                (CallStatus::Rejected, RuntimeControlCallResult::Unsupported)
            }
            Err(RuntimeControlLifecycleError::Unavailable) => {
                (CallStatus::Failed, RuntimeControlCallResult::Unavailable)
            }
            Err(RuntimeControlLifecycleError::CommandFailed) => {
                (CallStatus::Unknown, RuntimeControlCallResult::Unknown)
            }
        };
        detail.result = Some(result);
        (status, detail)
    }
}

pub async fn begin_runtime_control_call(
    recorder: Option<&CallRecorder>,
    operation: RuntimeControlOperation,
    endpoint: &RuntimeEndpoint,
) -> Result<Option<RuntimeControlCallContext>, CallLogError> {
    match recorder {
        Some(recorder) => recorder
            .begin(
                operation.command(),
                &RuntimeControlCallDetail::new(endpoint),
            )
            .await
            .map(Some),
        None => Ok(None),
    }
}

pub async fn finish_runtime_control_call(
    call: Option<RuntimeControlCallContext>,
    status: CallStatus,
    detail: &RuntimeControlCallDetail,
) {
    if let Some(call) = call {
        if let Err(error) = call.finish(status, detail).await {
            eprintln!(
                "[runtime-control] call_id={} terminal={status:?} safe_detail={} completion audit failed: {error}",
                call.id().as_str(),
                serde_json::to_string(detail).unwrap_or_default(),
            );
        }
    }
}
