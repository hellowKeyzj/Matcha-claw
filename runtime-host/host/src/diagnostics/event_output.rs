use std::time::{SystemTime, UNIX_EPOCH};

use foundation::{
    execution::{
        EventObservation, EventReason, EventStage, ObservationRecord, ObservationSink, TraceContext,
    },
    process::supervision::SupervisorSnapshot,
};
use openclaw::{port::CronExecutionStatus, session::events::SessionEvent};

use crate::{
    HostEvent, RuntimeLifecycle, RuntimeState,
    control::{CronExecutionId, SafeCronExecutionStatus, SafeEvent, SafeRuntimeLifecycle},
};

const OPENCLAW_LIFECYCLE_EVENT: &str = "openclaw.lifecycle";
const OPENCLAW_CANONICAL_EVENT: &str = "openclaw.canonical";
const OPENCLAW_RUNTIME_EVENT: &str = "openclaw.runtime";
const OPENCLAW_CRON_EXECUTION_EVENT: &str = "openclaw.cron.execution";
const MATCHA_SESSION_EVENT: &str = "matcha.session";
const MATCHA_LIFECYCLE_EVENT: &str = "matcha.lifecycle";

pub(crate) fn project_observed(
    event: HostEvent,
    observation: &ObservationSink,
) -> Option<SafeEvent> {
    match event {
        HostEvent::OpenClaw(event) => project_openclaw_observed(event, observation),
        HostEvent::OpenClawCanonical(_) => drop_unsupported(observation, OPENCLAW_CANONICAL_EVENT),
        HostEvent::OpenClawCronExecution {
            job_id,
            run_id,
            status,
        } => project_openclaw_cron_observed(job_id, run_id, status, observation),
        HostEvent::OpenClawRuntime => project_accepted(
            observation,
            OPENCLAW_RUNTIME_EVENT,
            SafeEvent::OpenClawRuntime {},
        ),
        HostEvent::Matcha(_) => drop_unsupported(observation, MATCHA_SESSION_EVENT),
        HostEvent::MatchaLifecycle(snapshot) => {
            project_matcha_lifecycle_observed(snapshot, observation)
        }
    }
}

fn project_openclaw_observed(
    event: SessionEvent,
    observation: &ObservationSink,
) -> Option<SafeEvent> {
    match project_openclaw(event) {
        Some(event) => project_accepted(observation, OPENCLAW_LIFECYCLE_EVENT, event),
        None => drop_unsupported(observation, OPENCLAW_LIFECYCLE_EVENT),
    }
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

fn project_openclaw_cron_observed(
    job_id: String,
    run_id: String,
    status: CronExecutionStatus,
    observation: &ObservationSink,
) -> Option<SafeEvent> {
    let Some(job_id) = CronExecutionId::try_new(job_id) else {
        return drop_validation_rejected(observation, OPENCLAW_CRON_EXECUTION_EVENT);
    };
    let Some(run_id) = CronExecutionId::try_new(run_id) else {
        return drop_validation_rejected(observation, OPENCLAW_CRON_EXECUTION_EVENT);
    };

    observe_event(
        observation,
        OPENCLAW_CRON_EXECUTION_EVENT,
        EventStage::Validate,
        EventReason::Accepted,
    );
    project_accepted(
        observation,
        OPENCLAW_CRON_EXECUTION_EVENT,
        SafeEvent::OpenClawCronExecution {
            job_id,
            run_id,
            status: status.into(),
        },
    )
}

fn project_matcha_lifecycle_observed(
    snapshot: SupervisorSnapshot,
    observation: &ObservationSink,
) -> Option<SafeEvent> {
    let lifecycle = RuntimeState::from_snapshot(&snapshot).lifecycle();
    project_accepted(
        observation,
        MATCHA_LIFECYCLE_EVENT,
        SafeEvent::MatchaLifecycle {
            lifecycle: safe_runtime_lifecycle(lifecycle),
            ready: lifecycle == RuntimeLifecycle::Running,
            observed_at_ms: observed_at_ms(),
        },
    )
}

fn drop_validation_rejected(
    observation: &ObservationSink,
    event_kind: &'static str,
) -> Option<SafeEvent> {
    observe_event(
        observation,
        event_kind,
        EventStage::Validate,
        EventReason::ValidationRejected,
    );
    observe_event(
        observation,
        event_kind,
        EventStage::Drop,
        EventReason::ValidationRejected,
    );
    None
}

fn drop_unsupported(observation: &ObservationSink, event_kind: &'static str) -> Option<SafeEvent> {
    observe_event(
        observation,
        event_kind,
        EventStage::Drop,
        EventReason::Unsupported,
    );
    None
}

fn project_accepted(
    observation: &ObservationSink,
    event_kind: &'static str,
    event: SafeEvent,
) -> Option<SafeEvent> {
    observe_event(
        observation,
        event_kind,
        EventStage::Project,
        EventReason::Accepted,
    );
    Some(event)
}

fn observe_event(
    observation: &ObservationSink,
    event_kind: &'static str,
    stage: EventStage,
    reason: EventReason,
) {
    observation.observe(ObservationRecord::Event(EventObservation {
        trace: TraceContext::absent(),
        event_kind,
        stage,
        reason: Some(reason),
    }));
}

fn safe_runtime_lifecycle(lifecycle: RuntimeLifecycle) -> SafeRuntimeLifecycle {
    match lifecycle {
        RuntimeLifecycle::Unavailable => SafeRuntimeLifecycle::Unavailable,
        RuntimeLifecycle::Idle => SafeRuntimeLifecycle::Idle,
        RuntimeLifecycle::Starting => SafeRuntimeLifecycle::Starting,
        RuntimeLifecycle::Running => SafeRuntimeLifecycle::Running,
        RuntimeLifecycle::Stopping => SafeRuntimeLifecycle::Stopping,
        RuntimeLifecycle::WaitingToRestart => SafeRuntimeLifecycle::WaitingToRestart,
        RuntimeLifecycle::Failed => SafeRuntimeLifecycle::Failed,
        RuntimeLifecycle::ShutDown => SafeRuntimeLifecycle::ShutDown,
    }
}

fn observed_at_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
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
