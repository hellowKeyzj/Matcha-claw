use platform::call::{CallContext, CallDetail, CallStatus};
use serde::Serialize;

use crate::{PrepareOutcome, PythonReadiness, ToolAvailability, ToolchainStatus};

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ToolchainCallDetail {
    Status {
        uv: Option<ToolAvailability>,
        python: Option<PythonReadiness>,
        failure: Option<CallFailure>,
    },
    Prepare {
        #[serde(rename = "pythonVersion")]
        python_version: &'static str,
        outcome: Option<PrepareOutcome>,
        failure: Option<CallFailure>,
    },
}

impl CallDetail for ToolchainCallDetail {
    const MODULE: &'static str = "toolchain";
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CallFailure {
    AdmissionClosed,
    OwnerUnavailable,
    QueueFull,
    RecordingUnavailable,
}

impl ToolchainCallDetail {
    pub fn status() -> Self {
        Self::Status {
            uv: None,
            python: None,
            failure: None,
        }
    }

    pub fn prepare() -> Self {
        Self::Prepare {
            python_version: "3.12",
            outcome: None,
            failure: None,
        }
    }

    pub fn observed(status: &ToolchainStatus) -> Self {
        Self::Status {
            uv: Some(status.uv()),
            python: Some(status.python()),
            failure: None,
        }
    }

    pub fn prepared(outcome: PrepareOutcome) -> Self {
        Self::Prepare {
            python_version: "3.12",
            outcome: Some(outcome),
            failure: None,
        }
    }

    pub fn failed(mut self, category: CallFailure) -> Self {
        match &mut self {
            Self::Status { failure, .. } | Self::Prepare { failure, .. } => {
                *failure = Some(category)
            }
        }
        self
    }
}

pub(crate) async fn finish(
    context: Option<&CallContext<ToolchainCallDetail>>,
    status: CallStatus,
    detail: &ToolchainCallDetail,
) {
    if let Some(context) = context {
        if let Err(error) = context.finish(status, detail).await {
            eprintln!(
                "[toolchain:call] terminal record failed call_id={} error={error}",
                context.id().as_str()
            );
        }
    }
}

pub(crate) fn observed_status(status: &ToolchainStatus) -> CallStatus {
    match (status.uv(), status.python()) {
        (ToolAvailability::Unknown, _) | (_, PythonReadiness::Unknown) => CallStatus::Unknown,
        (ToolAvailability::Unsupported, _) | (_, PythonReadiness::Unsupported) => {
            CallStatus::Rejected
        }
        _ => CallStatus::Succeeded,
    }
}

pub(crate) fn prepared_status(outcome: PrepareOutcome) -> CallStatus {
    match outcome {
        PrepareOutcome::Ready | PrepareOutcome::Installed => CallStatus::Succeeded,
        PrepareOutcome::Rejected | PrepareOutcome::Unsupported => CallStatus::Rejected,
        PrepareOutcome::Unknown => CallStatus::Unknown,
        PrepareOutcome::Unavailable => CallStatus::Failed,
    }
}
