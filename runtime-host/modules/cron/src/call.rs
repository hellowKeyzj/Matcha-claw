use std::sync::Arc;

use platform::call::{
    CallContext, CallDetail, CallId, CallLogError, CallReceipt, CallRecorder, CallStatus,
};
use serde::Serialize;
use tokio::sync::OnceCell;

use crate::model::{
    CronExecutionTerminalStatus, CronScheduleCommand, CronTriggerResult, CronTriggerSkipReason,
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CronCallDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_kind: Option<ScheduleKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<SkipReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_status: Option<ExecutionStatus>,
}

impl CallDetail for CronCallDetail {
    const MODULE: &'static str = "cron";
}

impl CronCallDetail {
    pub fn job(job_id: &str) -> Self {
        Self {
            job_id: safe_id(job_id),
            ..Self::default()
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ScheduleKind {
    Cron,
    At,
    Every,
}

impl From<&CronScheduleCommand> for ScheduleKind {
    fn from(schedule: &CronScheduleCommand) -> Self {
        match schedule {
            CronScheduleCommand::Cron { .. } => Self::Cron,
            CronScheduleCommand::At { .. } => Self::At,
            CronScheduleCommand::Every { .. } => Self::Every,
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Outcome {
    Applied,
    Listed,
    Loaded,
    Accepted,
    Skipped,
    Rejected,
    Unavailable,
    Protocol,
    Deadline,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SkipReason {
    AlreadyRunning,
    NotDue,
    InvalidSpec,
    Disabled,
    Stopped,
}

impl From<&CronTriggerSkipReason> for SkipReason {
    fn from(reason: &CronTriggerSkipReason) -> Self {
        match reason {
            CronTriggerSkipReason::AlreadyRunning => Self::AlreadyRunning,
            CronTriggerSkipReason::NotDue => Self::NotDue,
            CronTriggerSkipReason::InvalidSpec => Self::InvalidSpec,
            CronTriggerSkipReason::Disabled => Self::Disabled,
            CronTriggerSkipReason::Stopped => Self::Stopped,
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExecutionStatus {
    Waiting,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    OutcomeUnknown,
}

impl From<CronExecutionTerminalStatus> for ExecutionStatus {
    fn from(status: CronExecutionTerminalStatus) -> Self {
        match status {
            CronExecutionTerminalStatus::Succeeded => Self::Succeeded,
            CronExecutionTerminalStatus::Failed => Self::Failed,
            CronExecutionTerminalStatus::Skipped => Self::Skipped,
            CronExecutionTerminalStatus::Cancelled => Self::Cancelled,
            CronExecutionTerminalStatus::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

pub(crate) fn safe_id(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')))
    .then(|| value.to_owned())
}

#[derive(Clone)]
pub(crate) struct CronCall {
    context: CallContext<CronCallDetail>,
    pub detail: CronCallDetail,
    admission: Arc<OnceCell<Result<CallReceipt, CallLogError>>>,
}

impl CronCall {
    pub async fn begin(
        recorder: Option<&CallRecorder>,
        command: &'static str,
        detail: CronCallDetail,
    ) -> Option<Self> {
        let recorder = recorder?;
        match recorder.begin(command, &detail).await {
            Ok(context) => Some(Self {
                context,
                detail,
                admission: Arc::new(OnceCell::new()),
            }),
            Err(error) => {
                report_error(error);
                None
            }
        }
    }

    pub(crate) fn id(&self) -> &CallId {
        self.context.id()
    }

    pub(crate) async fn accepted(&self) -> Result<CallReceipt, CallLogError> {
        self.admission
            .get_or_init(|| self.context.accepted())
            .await
            .clone()
    }

    pub async fn running(&self) -> bool {
        if let Err(error) = self.accepted().await {
            report_error(error);
            return false;
        }
        if let Err(error) = self.context.running().await {
            report_error(error);
            return false;
        }
        true
    }

    pub async fn finish(&mut self, status: CallStatus, outcome: Outcome) {
        self.detail.outcome = Some(outcome);
        if let Err(error) = self.context.finish(status, &self.detail).await {
            report_error(error);
        }
    }

    pub async fn finish_trigger(
        &mut self,
        result: &Result<CronTriggerResult, crate::ports::CronRequestAdmissionClosed>,
    ) {
        let (status, outcome) = match result {
            Ok(CronTriggerResult::Accepted) => {
                // A native legacy receipt confirms admission, not a correlatable terminal run.
                if self.detail.execution_status.is_none() {
                    self.detail.execution_status = Some(ExecutionStatus::OutcomeUnknown);
                }
                (CallStatus::Succeeded, Outcome::Accepted)
            }
            Ok(CronTriggerResult::Skipped(reason)) => {
                self.detail.skip_reason = Some(reason.into());
                (CallStatus::Succeeded, Outcome::Skipped)
            }
            Ok(CronTriggerResult::OutcomeUnknown) => (CallStatus::Unknown, Outcome::OutcomeUnknown),
            Err(_) => (CallStatus::Rejected, Outcome::Unavailable),
        };
        self.finish(status, outcome).await;
    }

    pub async fn terminal(&mut self, status: CronExecutionTerminalStatus) {
        self.detail.execution_status = Some(status.into());
        // The call's terminal status describes this admission, never the later native run.
        if let Err(error) = self.context.update(&self.detail).await {
            report_error(error);
        }
    }
}

fn report_error(error: CallLogError) {
    eprintln!("[cron.call-log] {error}");
}
