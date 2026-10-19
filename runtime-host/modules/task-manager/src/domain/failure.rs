use serde::Serialize;

use super::model::TaskOutcome;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskFailureStage {
    Admission,
    Runtime,
    SessionLookup,
    TaskRequest,
    NativeStart,
    NativeControl,
    NativeRead,
    Response,
    Transport,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskFailureCode {
    AdmissionClosed,
    Unsupported,
    RuntimeNotReady,
    OwnerUnavailable,
    InvalidIdentity,
    OwnershipMismatch,
    NotFound,
    ConnectFailed,
    ConnectionClosed,
    UpgradeFailed,
    Deadline,
    Cancelled,
    AuthenticationFailed,
    UnsupportedProtocol,
    MethodNotFound,
    InvalidParams,
    NativeStartFailed,
    NativeInstanceAbsent,
    NativeInstanceChanged,
    NativeCleanupUnconfirmed,
    SessionClosed,
    NativeControlError,
    NativeResponseLost,
    TaskIo,
    TodoIo,
    TaskNativeSchema,
    TaskLockConflict,
    TodoConflict,
    TodoSessionBusy,
    TaskDependencyMissing,
    TodoOwnerInactive,
    TodoPersistenceDisabled,
    ReceiptInvalid,
    Protocol,
    Transport,
    RequestRejected,
    RemoteError,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub enum TaskDelivery {
    #[serde(rename = "notSent")]
    NotSent,
    #[serde(rename = "sent")]
    Sent,
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "responseReceived")]
    ResponseReceived,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFailure {
    pub stage: TaskFailureStage,
    pub code: TaskFailureCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rpc_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<TaskDelivery>,
}

impl TaskFailure {
    pub fn new(stage: TaskFailureStage, code: TaskFailureCode) -> Self {
        Self {
            stage,
            code,
            rpc_code: None,
            delivery: None,
        }
    }
}

pub struct TaskExecution {
    pub outcome: TaskOutcome,
    pub failure: Option<TaskFailure>,
}

impl TaskExecution {
    pub fn new(outcome: TaskOutcome) -> Self {
        Self {
            outcome,
            failure: None,
        }
    }

    pub fn failed(outcome: TaskOutcome, failure: TaskFailure) -> Self {
        Self {
            outcome,
            failure: Some(failure),
        }
    }
}
