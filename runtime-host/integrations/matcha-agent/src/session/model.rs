use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;

use super::{approval::ApprovalRecord, protocol_event::EventEnvelope};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ValidationError(&'static str);

impl ValidationError {
    pub(crate) const fn new(message: &'static str) -> Self {
        Self(message)
    }

    pub fn message(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for ValidationError {}

macro_rules! string_id {
    ($name:ident, $error:literal) => {
        #[derive(Clone, Eq, Hash, PartialEq, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn try_new(value: impl Into<String>) -> Result<Self, ValidationError> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(ValidationError::new($error));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(concat!(stringify!($name), "([REDACTED])"))
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::try_new(String::deserialize(deserializer)?).map_err(D::Error::custom)
            }
        }
    };
}

string_id!(SessionId, "session id must be a non-empty string");
string_id!(RunId, "run id must be a non-empty string");
string_id!(MessageId, "message id must be a non-empty string");
string_id!(EventId, "event id must be a non-empty string");
string_id!(WorkerId, "worker id must be a non-empty string");
string_id!(ClientId, "client id must be a non-empty string");
string_id!(ApprovalId, "approval id must be a non-empty string");
string_id!(OptionId, "option id must be a non-empty string");
string_id!(ToolCallId, "tool call id must be a non-empty string");

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Sequence(u64);

impl Sequence {
    pub fn try_new(value: u64) -> Result<Self, ValidationError> {
        if value > MAX_SAFE_INTEGER {
            return Err(ValidationError::new(
                "sequence must be a non-negative JavaScript-safe integer",
            ));
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for Sequence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::try_new(u64::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeCapabilities {
    pub event_replay: bool,
    pub snapshots: bool,
    pub approvals: bool,
    pub sdk_message_envelope: bool,
    pub blob_store: bool,
    pub session_transcript: bool,
}

impl InitializeCapabilities {
    pub(crate) fn is_v1(&self) -> bool {
        self.event_replay
            && self.snapshots
            && self.approvals
            && self.sdk_message_envelope
            && self.blob_store
            && self.session_transcript
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub server_version: String,
    pub capabilities: InitializeCapabilities,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: SessionId,
    pub created_at: String,
    pub updated_at: String,
    pub title: Option<String>,
    pub runtime: RuntimeKind,
    pub transcript_ref: Option<String>,
    pub has_conversation: Option<bool>,
    pub last_seq: Sequence,
    pub last_snapshot_version: u64,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub worker_state: WorkerRuntimeState,
}

impl fmt::Debug for SessionRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionRecord")
            .field("session_id", &self.session_id)
            .field("has_created_at", &!self.created_at.is_empty())
            .field("has_updated_at", &!self.updated_at.is_empty())
            .field("has_title", &self.title.is_some())
            .field("runtime", &self.runtime)
            .field("has_transcript_ref", &self.transcript_ref.is_some())
            .field("has_conversation", &self.has_conversation)
            .field("last_seq", &self.last_seq)
            .field("last_snapshot_version", &self.last_snapshot_version)
            .field("has_model", &self.model.is_some())
            .field("has_permission_mode", &self.permission_mode.is_some())
            .field("worker_state", &self.worker_state)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum RuntimeKind {
    #[serde(rename = "matcha-agent")]
    MatchaAgent,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkerRuntimeState {
    Unloaded {
        reason: UnloadedReason,
    },
    Spawning {
        worker_id: WorkerId,
        started_at: String,
    },
    Ready {
        worker_id: WorkerId,
        pid: u32,
        last_heartbeat_at: String,
    },
    Running {
        worker_id: WorkerId,
        run_id: RunId,
        started_at: String,
    },
    WaitingForApproval {
        worker_id: WorkerId,
        run_id: RunId,
        approval_ids: Vec<ApprovalId>,
    },
    Stopping {
        worker_id: WorkerId,
        reason: WorkerStopReason,
    },
    Crashed {
        worker_id: WorkerId,
        exit_code: Option<i32>,
        signal: Option<String>,
        restartable: bool,
    },
}

impl fmt::Debug for WorkerRuntimeState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unloaded { reason } => formatter
                .debug_struct("WorkerRuntimeState::Unloaded")
                .field("reason", reason)
                .finish(),
            Self::Spawning { .. } => formatter
                .debug_struct("WorkerRuntimeState::Spawning")
                .finish_non_exhaustive(),
            Self::Ready { .. } => formatter
                .debug_struct("WorkerRuntimeState::Ready")
                .finish_non_exhaustive(),
            Self::Running { .. } => formatter
                .debug_struct("WorkerRuntimeState::Running")
                .finish_non_exhaustive(),
            Self::WaitingForApproval { approval_ids, .. } => formatter
                .debug_struct("WorkerRuntimeState::WaitingForApproval")
                .field("approval_count", &approval_ids.len())
                .finish_non_exhaustive(),
            Self::Stopping { reason, .. } => formatter
                .debug_struct("WorkerRuntimeState::Stopping")
                .field("reason", reason)
                .finish_non_exhaustive(),
            Self::Crashed {
                exit_code,
                signal,
                restartable,
                ..
            } => formatter
                .debug_struct("WorkerRuntimeState::Crashed")
                .field("has_exit_code", &exit_code.is_some())
                .field("has_signal", &signal.is_some())
                .field("restartable", restartable)
                .finish_non_exhaustive(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnloadedReason {
    IdleTimeout,
    NotStarted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkerStopReason {
    Cancel,
    Shutdown,
    Restart,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionListResult {
    pub sessions: Vec<SessionRecord>,
}

impl fmt::Debug for SessionListResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionListResult")
            .field("session_count", &self.sessions.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptResult {
    pub run_id: RunId,
}

impl fmt::Debug for SessionPromptResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionPromptResult")
            .field("run_id", &self.run_id)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTranscriptResult {
    pub lines: Vec<String>,
}

impl fmt::Debug for SessionTranscriptResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionTranscriptResult")
            .field("line_count", &self.lines.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session: SessionRecord,
    pub version: u64,
    pub updated_at: String,
    pub runs: Vec<RunRecord>,
    pub messages: Vec<EventEnvelope>,
    pub pending_approvals: Vec<ApprovalRecord>,
    pub usage: Option<UsageSummary>,
}

impl fmt::Debug for SessionSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionSnapshot")
            .field("version", &self.version)
            .field("run_count", &self.runs.len())
            .field("message_count", &self.messages.len())
            .field("pending_approval_count", &self.pending_approvals.len())
            .field("has_usage", &self.usage.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub prompt_id: String,
    pub status: RunStatus,
}

impl fmt::Debug for RunRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunRecord")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunStatus {
    Queued {
        queued_at: String,
    },
    Running {
        started_at: String,
        worker_id: WorkerId,
    },
    WaitingForApproval {
        approval_ids: Vec<ApprovalId>,
    },
    Completed {
        completed_at: String,
        stop_reason: StopReason,
    },
    Cancelled {
        completed_at: String,
        reason: String,
    },
    Failed {
        completed_at: String,
        error: ClassifiedError,
    },
    Interrupted {
        completed_at: String,
        reason: RunInterruptionReason,
    },
}

impl fmt::Debug for RunStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Queued { .. } => formatter.debug_struct("Queued").finish_non_exhaustive(),
            Self::Running { .. } => formatter.debug_struct("Running").finish_non_exhaustive(),
            Self::WaitingForApproval { approval_ids } => formatter
                .debug_struct("WaitingForApproval")
                .field("approval_count", &approval_ids.len())
                .finish(),
            Self::Completed { stop_reason, .. } => formatter
                .debug_struct("Completed")
                .field("stop_reason", stop_reason)
                .finish(),
            Self::Cancelled { .. } => formatter.debug_struct("Cancelled").finish_non_exhaustive(),
            Self::Failed { error, .. } => formatter
                .debug_struct("Failed")
                .field("error", error)
                .finish_non_exhaustive(),
            Self::Interrupted { reason, .. } => formatter
                .debug_struct("Interrupted")
                .field("reason", reason)
                .finish(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunInterruptionReason {
    WorkerCrashed,
    ServerShutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_read_tokens: u64,
    pub cached_write_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedError {
    #[serde(rename = "type")]
    pub kind: ClassifiedErrorKind,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl fmt::Debug for ClassifiedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClassifiedError")
            .field("kind", &self.kind)
            .field("retryable", &self.retryable)
            .field("has_details", &self.details.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClassifiedErrorKind {
    InvalidRequest,
    Auth,
    Permission,
    Network,
    Aborted,
    Worker,
    Internal,
}

#[derive(Clone, PartialEq)]
pub enum WorkerResponse {
    Accepted {
        request_id: String,
    },
    Rejected {
        request_id: String,
        error: ClassifiedError,
    },
}

impl fmt::Debug for WorkerResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Accepted { .. } => formatter
                .debug_struct("WorkerResponse::Accepted")
                .finish_non_exhaustive(),
            Self::Rejected { error, .. } => formatter
                .debug_struct("WorkerResponse::Rejected")
                .field("error", error)
                .finish_non_exhaustive(),
        }
    }
}

impl<'de> Deserialize<'de> for WorkerResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let response = WorkerResponseWire::deserialize(deserializer)?;
        match (response.ok, response.error) {
            (true, None) => Ok(Self::Accepted {
                request_id: response.id,
            }),
            (false, Some(error)) => Ok(Self::Rejected {
                request_id: response.id,
                error,
            }),
            _ => Err(D::Error::custom("worker response shape is invalid")),
        }
    }
}

#[derive(Deserialize)]
struct WorkerResponseWire {
    id: String,
    ok: bool,
    error: Option<ClassifiedError>,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCancelResult {
    pub cancelled_run_ids: Vec<RunId>,
    pub worker_response: WorkerResponse,
}

impl fmt::Debug for SessionCancelResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCancelResult")
            .field("cancelled_run_count", &self.cancelled_run_ids.len())
            .field("worker_response", &self.worker_response)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_debug_redacts(value: &impl fmt::Debug, canaries: &[&str]) {
        let debug = format!("{value:?}");
        for canary in canaries {
            assert!(
                !debug.contains(canary),
                "debug output leaked {canary}: {debug}"
            );
        }
    }

    #[test]
    fn validated_identifiers_reject_empty_values_without_echoing_them() {
        let secret = "  ";
        let error = SessionId::try_new(secret).unwrap_err();
        assert_eq!(error.to_string(), "session id must be a non-empty string");
        assert!(!error.to_string().contains(secret));
        assert!(Sequence::try_new(MAX_SAFE_INTEGER + 1).is_err());
    }

    #[test]
    fn identifier_debug_redacts_every_identity_kind() {
        assert_debug_redacts(
            &SessionId::try_new("session-id-canary").unwrap(),
            &["session-id-canary"],
        );
        assert_debug_redacts(
            &RunId::try_new("run-id-canary").unwrap(),
            &["run-id-canary"],
        );
        assert_debug_redacts(
            &MessageId::try_new("message-id-canary").unwrap(),
            &["message-id-canary"],
        );
        assert_debug_redacts(
            &EventId::try_new("event-id-canary").unwrap(),
            &["event-id-canary"],
        );
        assert_debug_redacts(
            &WorkerId::try_new("worker-id-canary").unwrap(),
            &["worker-id-canary"],
        );
        assert_debug_redacts(
            &ClientId::try_new("client-id-canary").unwrap(),
            &["client-id-canary"],
        );
        assert_debug_redacts(
            &ApprovalId::try_new("approval-id-canary").unwrap(),
            &["approval-id-canary"],
        );
        assert_debug_redacts(
            &OptionId::try_new("option-id-canary").unwrap(),
            &["option-id-canary"],
        );
        assert_debug_redacts(
            &ToolCallId::try_new("tool-call-id-canary").unwrap(),
            &["tool-call-id-canary"],
        );
    }

    #[test]
    fn worker_state_debug_redacts_identity_timestamps_and_details() {
        let states = [
            WorkerRuntimeState::Spawning {
                worker_id: WorkerId::try_new("spawning-worker-canary").unwrap(),
                started_at: "spawning-timestamp-canary".into(),
            },
            WorkerRuntimeState::Ready {
                worker_id: WorkerId::try_new("ready-worker-canary").unwrap(),
                pid: 42,
                last_heartbeat_at: "heartbeat-timestamp-canary".into(),
            },
            WorkerRuntimeState::Running {
                worker_id: WorkerId::try_new("running-worker-canary").unwrap(),
                run_id: RunId::try_new("running-run-canary").unwrap(),
                started_at: "running-timestamp-canary".into(),
            },
            WorkerRuntimeState::WaitingForApproval {
                worker_id: WorkerId::try_new("approval-worker-canary").unwrap(),
                run_id: RunId::try_new("approval-run-canary").unwrap(),
                approval_ids: vec![ApprovalId::try_new("approval-canary").unwrap()],
            },
            WorkerRuntimeState::Stopping {
                worker_id: WorkerId::try_new("stopping-worker-canary").unwrap(),
                reason: WorkerStopReason::Cancel,
            },
            WorkerRuntimeState::Crashed {
                worker_id: WorkerId::try_new("crashed-worker-canary").unwrap(),
                exit_code: Some(1),
                signal: Some("crash-signal-canary".into()),
                restartable: true,
            },
        ];
        let canaries = [
            "spawning-worker-canary",
            "spawning-timestamp-canary",
            "ready-worker-canary",
            "heartbeat-timestamp-canary",
            "running-worker-canary",
            "running-run-canary",
            "running-timestamp-canary",
            "approval-worker-canary",
            "approval-run-canary",
            "approval-canary",
            "stopping-worker-canary",
            "crashed-worker-canary",
            "crash-signal-canary",
        ];

        for state in states {
            assert_debug_redacts(&state, &canaries);
        }
    }

    #[test]
    fn session_result_debug_redacts_workspace_metadata_and_transcript() {
        let session = SessionRecord {
            session_id: SessionId::try_new("record-session-canary").unwrap(),
            created_at: "created-timestamp-canary".into(),
            updated_at: "updated-timestamp-canary".into(),
            title: Some("session-title-canary".into()),
            runtime: RuntimeKind::MatchaAgent,
            transcript_ref: Some("transcript-ref-canary".into()),
            has_conversation: Some(true),
            last_seq: Sequence::try_new(7).unwrap(),
            last_snapshot_version: 3,
            model: Some("model-name-canary".into()),
            permission_mode: Some("permission-mode-canary".into()),
            worker_state: WorkerRuntimeState::Running {
                worker_id: WorkerId::try_new("record-worker-canary").unwrap(),
                run_id: RunId::try_new("record-run-canary").unwrap(),
                started_at: "record-worker-timestamp-canary".into(),
            },
        };
        let canaries = [
            "record-session-canary",
            "created-timestamp-canary",
            "updated-timestamp-canary",
            "session-title-canary",
            "transcript-ref-canary",
            "model-name-canary",
            "permission-mode-canary",
            "record-worker-canary",
            "record-run-canary",
            "record-worker-timestamp-canary",
        ];

        assert_debug_redacts(&session, &canaries);
        assert_debug_redacts(
            &SessionListResult {
                sessions: vec![session],
            },
            &canaries,
        );
        assert_debug_redacts(
            &SessionPromptResult {
                run_id: RunId::try_new("prompt-run-canary").unwrap(),
            },
            &["prompt-run-canary"],
        );
        assert_debug_redacts(
            &SessionTranscriptResult {
                lines: vec!["transcript-line-canary".into()],
            },
            &["transcript-line-canary"],
        );
    }

    #[test]
    fn error_response_and_cancel_debug_redact_peer_payloads() {
        let error = ClassifiedError {
            kind: ClassifiedErrorKind::Worker,
            message: "peer-message-canary".into(),
            retryable: true,
            details: Some(serde_json::json!({
                "raw-key-canary": "raw-value-canary"
            })),
        };
        let error_canaries = ["peer-message-canary", "raw-key-canary", "raw-value-canary"];
        assert_debug_redacts(&error, &error_canaries);
        assert_debug_redacts(
            &WorkerResponse::Accepted {
                request_id: "accepted-request-canary".into(),
            },
            &["accepted-request-canary"],
        );
        assert_debug_redacts(
            &WorkerResponse::Rejected {
                request_id: "rejected-request-canary".into(),
                error: error.clone(),
            },
            &[
                "rejected-request-canary",
                "peer-message-canary",
                "raw-key-canary",
                "raw-value-canary",
            ],
        );
        assert_debug_redacts(
            &SessionCancelResult {
                cancelled_run_ids: vec![RunId::try_new("cancelled-run-canary").unwrap()],
                worker_response: WorkerResponse::Rejected {
                    request_id: "cancel-request-canary".into(),
                    error,
                },
            },
            &[
                "cancelled-run-canary",
                "cancel-request-canary",
                "peer-message-canary",
                "raw-key-canary",
                "raw-value-canary",
            ],
        );
    }
}
