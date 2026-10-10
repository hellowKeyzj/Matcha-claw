use serde::Serialize;

use super::lifecycle::OwnedRuntimeFuture;

pub trait RuntimeControlOps: Send + Sync {
    fn logs(
        &self,
        cursor: Option<u64>,
    ) -> OwnedRuntimeFuture<Result<RuntimeLogSnapshot, RuntimeControlFailure>>;

    fn control_readiness(
        &self,
    ) -> OwnedRuntimeFuture<Result<RuntimeControlReadiness, RuntimeControlFailure>>;

    fn gateway_health(
        &self,
        probe: bool,
    ) -> OwnedRuntimeFuture<Result<RuntimeGatewayHealth, RuntimeControlFailure>>;

    fn gateway_status(
        &self,
        include_channel_summary: bool,
    ) -> OwnedRuntimeFuture<Result<RuntimeGatewayStatus, RuntimeControlFailure>>;

    fn control_ui_url(&self) -> OwnedRuntimeFuture<Result<String, RuntimeControlFailure>>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeLogEntry {
    pub source: &'static str,
    pub line: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeLogSnapshot {
    pub entries: Vec<RuntimeLogEntry>,
    pub cursor: u64,
    pub reset: bool,
    pub truncated: bool,
    pub lifecycle_tail_evicted: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeControlReadiness {
    Ready,
    Starting,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeGatewayHealth {
    pub ok: bool,
    pub timestamp_ms: u64,
    pub duration_ms: u64,
    pub channel_count: usize,
    pub agent_count: usize,
    pub session_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeGatewayStatus {
    pub session_count: usize,
    pub channel_count: usize,
    pub heartbeat_enabled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeControlFailure {
    Unsupported,
    Unavailable,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeControlLifecycleStatus {
    pub lifecycle: RuntimeControlLifecycle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<RuntimeControlLifecycleFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_diagnostic: Option<RuntimeControlStartupDiagnostic>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeControlLifecycle {
    Unavailable,
    Idle,
    Starting,
    Running,
    Stopping,
    WaitingToRestart,
    Failed,
    ShutDown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeControlLifecycleFailure {
    ArtifactUnavailable,
    PermissionDenied,
    ResourceUnavailable,
    PlatformRejected,
    Stdio,
    Readiness,
    UnexpectedExit,
    AuthorityLost,
    CleanupUnconfirmed,
    MaterialCleanupFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeControlStartupDiagnostic {
    PortConflict,
    ConfigurationRejected,
    AppServerReportedError,
    UnclassifiedStderr,
    InvalidUtf8,
    LineTooLong,
    ListenerReported,
    BindRejected,
    StartupFailed,
    InvalidEncoding,
    DiagnosticLimitReached,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRepairSnapshot {
    pub phase: RuntimeRepairPhase,
    pub trigger: Option<RuntimeRepairTrigger>,
    pub failure: Option<RuntimeRepairFailure>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeRepairPhase {
    Idle,
    Stopping,
    Repairing,
    Preparing,
    Starting,
    Succeeded,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeRepairTrigger {
    Automatic,
    Manual,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeRepairFailure {
    StopFailed,
    DoctorFailed,
    DoctorTimedOut,
    DoctorCancelled,
    DoctorSpawnFailed,
    PreparationFailed,
    StartFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeControlLifecycleError {
    Busy,
    Unsupported,
    Unavailable,
    CommandFailed,
}
