use crate::{
    HostEvent,
    control::{CronExecutionId, SafeCronExecutionStatus, SafeEvent},
    session_state::SessionDelta,
};
use openclaw::{port::CronExecutionStatus, session::events::SessionEvent};

pub(crate) fn project(event: HostEvent) -> Option<SafeEvent> {
    match event {
        HostEvent::OpenClaw(event) => project_openclaw(event),
        HostEvent::OpenClawCanonical(_) => None,
        HostEvent::OpenClawCronExecution {
            job_id,
            run_id,
            status,
        } => project_openclaw_cron(job_id, run_id, status),
        HostEvent::OpenClawRuntime => Some(SafeEvent::OpenClawRuntime),
        HostEvent::SessionDelta(delta) => project_session_delta(delta),
        // Session activity is no longer a wire event.
        HostEvent::Matcha(_) => None,
    }
}

/// Projects the canonical host-owned session DTO. Native peer events must not be
/// adapted into a legacy activity/update wire shape.
pub(crate) fn project_session_delta(delta: SessionDelta) -> Option<SafeEvent> {
    crate::control::validate_session_delta(&delta).then_some(SafeEvent::SessionDelta { delta })
}

fn project_openclaw(event: SessionEvent) -> Option<SafeEvent> {
    let lifecycle = event.lifecycle_event()?;
    Some(SafeEvent::OpenClawLifecycle {
        sequence: lifecycle.sequence(),
        has_run: lifecycle.has_run(),
        has_message: lifecycle.has_message(),
        has_session_activity: lifecycle.has_session_activity(),
    })
}

fn project_openclaw_cron(
    job_id: String,
    run_id: String,
    status: CronExecutionStatus,
) -> Option<SafeEvent> {
    Some(SafeEvent::OpenClawCronExecution {
        job_id: CronExecutionId::try_new(job_id)?,
        run_id: CronExecutionId::try_new(run_id)?,
        status: status.into(),
    })
}

impl From<CronExecutionStatus> for SafeCronExecutionStatus {
    fn from(status: CronExecutionStatus) -> Self {
        match status {
            CronExecutionStatus::Succeeded => Self::Succeeded,
            CronExecutionStatus::Failed => Self::Failed,
            CronExecutionStatus::Skipped => Self::Skipped,
            CronExecutionStatus::Cancelled => Self::Cancelled,
            CronExecutionStatus::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}
