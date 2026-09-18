use std::fmt;

use super::{
    client::{AppServerClient, AppServerClientError},
    model::{RunId, RunStatus, SessionId},
    request::SessionSnapshotParams,
};

/// Reads a durable native run receipt without consuming the session event stream.
///
/// This consumer performs exactly one read for a distinct `(session_id, run_id)`
/// pair. It does not retry a failed request and never treats a failed read as a
/// missing receipt.
pub struct TerminalRunReceiptConsumer<'client> {
    client: &'client AppServerClient,
}

impl<'client> TerminalRunReceiptConsumer<'client> {
    pub fn new(client: &'client AppServerClient) -> Self {
        Self { client }
    }

    /// Reads the current terminal-receipt observation for one native run.
    ///
    /// Native queued, running, and approval-waiting states remain [`TerminalRunReceipt::Pending`].
    /// Connection, restart, deadline, or protocol failures remain fixed
    /// [`AppServerClientError`] values and are never collapsed into `NotFound`.
    pub async fn read(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<TerminalRunReceipt, AppServerClientError> {
        let snapshot = self
            .client
            .snapshot_session(SessionSnapshotParams::new(session_id))
            .await?;
        let status = snapshot
            .runs
            .into_iter()
            .find(|run| run.run_id == run_id)
            .map(|run| run.status);
        Ok(TerminalRunReceipt::from_snapshot_status(status))
    }
}

/// The terminal-receipt state observed for one `(sessionId, runId)` pair.
///
/// `Pending` confirms that the native run exists but has not reached a terminal
/// status. It is intentionally distinct from `NotFound`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalRunReceipt {
    Pending,
    NotFound,
    Found { status: TerminalRunStatus },
}

impl TerminalRunReceipt {
    fn from_snapshot_status(status: Option<RunStatus>) -> Self {
        match status {
            None => Self::NotFound,
            Some(
                RunStatus::Queued { .. }
                | RunStatus::Running { .. }
                | RunStatus::WaitingForApproval { .. },
            ) => Self::Pending,
            Some(RunStatus::Completed { .. }) => Self::Found {
                status: TerminalRunStatus::Completed,
            },
            Some(RunStatus::Cancelled { .. }) => Self::Found {
                status: TerminalRunStatus::Cancelled,
            },
            Some(RunStatus::Failed { .. }) => Self::Found {
                status: TerminalRunStatus::Failed,
            },
            Some(RunStatus::Interrupted { .. }) => Self::Found {
                status: TerminalRunStatus::Interrupted,
            },
        }
    }
}

/// The fixed terminal outcomes accepted from the native app-server receipt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalRunStatus {
    Completed,
    Cancelled,
    Failed,
    Interrupted,
}

#[derive(Clone, Eq, PartialEq)]
pub struct NativeRunSettled {
    native_run_id: RunId,
    status: TerminalRunStatus,
    final_assistant_text: Option<String>,
}

impl NativeRunSettled {
    pub fn new(
        native_run_id: RunId,
        status: TerminalRunStatus,
        final_assistant_text: Option<String>,
    ) -> Self {
        Self {
            native_run_id,
            status,
            final_assistant_text,
        }
    }

    pub fn native_run_id(&self) -> &RunId {
        &self.native_run_id
    }

    pub const fn status(&self) -> TerminalRunStatus {
        self.status
    }

    pub fn final_assistant_text(&self) -> Option<&str> {
        self.final_assistant_text.as_deref()
    }
}

impl fmt::Debug for NativeRunSettled {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeRunSettled")
            .field("status", &self.status)
            .field(
                "final_assistant_text_bytes",
                &self.final_assistant_text.as_ref().map_or(0, String::len),
            )
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn run_status(value: serde_json::Value) -> RunStatus {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn receipt_preserves_not_found_and_pending_without_synthesizing_terminal_state() {
        assert_eq!(
            TerminalRunReceipt::from_snapshot_status(None),
            TerminalRunReceipt::NotFound,
        );
        for status in [
            json!({"type":"queued","queuedAt":"queued-at"}),
            json!({"type":"running","startedAt":"started-at","workerId":"worker-1"}),
            json!({"type":"waitingForApproval","approvalIds":["approval-1"]}),
        ] {
            assert_eq!(
                TerminalRunReceipt::from_snapshot_status(Some(run_status(status))),
                TerminalRunReceipt::Pending,
            );
        }
    }

    #[test]
    fn receipt_projects_only_native_terminal_statuses() {
        for (native, expected) in [
            (
                json!({"type":"completed","completedAt":"completed-at","stopReason":"end_turn"}),
                TerminalRunStatus::Completed,
            ),
            (
                json!({"type":"cancelled","completedAt":"completed-at","reason":"cancelled"}),
                TerminalRunStatus::Cancelled,
            ),
            (
                json!({"type":"failed","completedAt":"completed-at","error":{"type":"network","message":"failed","retryable":false,"details":null}}),
                TerminalRunStatus::Failed,
            ),
            (
                json!({"type":"interrupted","completedAt":"completed-at","reason":"workerCrashed"}),
                TerminalRunStatus::Interrupted,
            ),
        ] {
            assert_eq!(
                TerminalRunReceipt::from_snapshot_status(Some(run_status(native))),
                TerminalRunReceipt::Found { status: expected },
            );
        }
    }

    #[test]
    fn receipt_debug_contains_no_native_identifiers_or_payloads() {
        let receipt = TerminalRunReceipt::Found {
            status: TerminalRunStatus::Completed,
        };
        let debug = format!("{receipt:?}");
        for canary in [
            "session-canary",
            "run-canary",
            "transcript",
            "workspace",
            "worker",
            "credential",
            "path",
        ] {
            assert!(!debug.contains(canary));
        }
    }

    #[test]
    fn settled_debug_redacts_run_id_and_final_text() {
        let settled = NativeRunSettled::new(
            RunId::try_new("run-canary").unwrap(),
            TerminalRunStatus::Completed,
            Some("assistant final canary".to_owned()),
        );
        assert_eq!(settled.native_run_id().as_str(), "run-canary");
        assert_eq!(
            settled.final_assistant_text(),
            Some("assistant final canary")
        );
        let debug = format!("{settled:?}");
        assert!(!debug.contains("run-canary"));
        assert!(!debug.contains("assistant final canary"));
    }
}
