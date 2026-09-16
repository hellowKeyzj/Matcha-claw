pub(crate) fn cron_create_into_gateway(
    command: crate::cron::CronCreateCommand,
) -> Result<openclaw::gateway::wire::CronJobCreate, crate::cron::InvalidCronCommand> {
    let job = openclaw::gateway::wire::CronJobCreate::isolated_agent_turn(
        command.name,
        cron_schedule_into_gateway(command.schedule)?,
        openclaw::gateway::wire::CronWakeMode::NextHeartbeat,
        command.message,
    )
    .map_err(|_| crate::cron::InvalidCronCommand)?
    .with_agent_id(command.agent_id)
    .map_err(|_| crate::cron::InvalidCronCommand)?
    .with_model(command.model)
    .map_err(|_| crate::cron::InvalidCronCommand)?
    .with_enabled(command.enabled);
    match command.delivery {
        crate::cron::CronDeliveryCommand::None => Ok(job.with_no_delivery()),
        crate::cron::CronDeliveryCommand::Announce {
            channel,
            to,
            account_id,
        } => job
            .with_announcement_delivery(channel, to, account_id)
            .map_err(|_| crate::cron::InvalidCronCommand),
    }
}

pub(crate) fn cron_update_into_gateway(
    command: crate::cron::CronUpdateCommand,
) -> Result<
    (
        String,
        openclaw::gateway::wire::CronJobPatch,
        Option<String>,
    ),
    crate::cron::InvalidCronCommand,
> {
    let schedule = command
        .schedule
        .map(cron_schedule_into_gateway)
        .transpose()?;
    let mut update = openclaw::gateway::wire::CronJobUpdate::new(
        command.name,
        command.agent_id,
        command.message,
        command.model,
        schedule,
        command.enabled,
    )
    .map_err(|_| crate::cron::InvalidCronCommand)?;
    if let Some(delivery) = command.delivery {
        update = match delivery {
            crate::cron::CronDeliveryCommand::None => update.with_no_delivery(),
            crate::cron::CronDeliveryCommand::Announce {
                channel,
                to,
                account_id,
            } => update.with_announcement_delivery(channel, to, account_id),
        }
        .map_err(|_| crate::cron::InvalidCronCommand)?;
    }
    Ok((
        command.job_id,
        openclaw::gateway::wire::CronJobPatch::update(update),
        command.expected_config_revision,
    ))
}

pub(crate) fn cron_schedule_into_gateway(
    schedule: crate::cron::CronScheduleCommand,
) -> Result<openclaw::gateway::wire::CronSchedule, crate::cron::InvalidCronCommand> {
    match schedule {
        crate::cron::CronScheduleCommand::Cron { expr, tz: None } => {
            openclaw::gateway::wire::CronSchedule::cron(expr)
        }
        crate::cron::CronScheduleCommand::Cron { expr, tz } => {
            openclaw::gateway::wire::CronSchedule::cron_with_options(expr, tz, None)
        }
        crate::cron::CronScheduleCommand::At { at } => {
            openclaw::gateway::wire::CronSchedule::at(at)
        }
        crate::cron::CronScheduleCommand::Every {
            every_ms,
            anchor_ms,
        } => openclaw::gateway::wire::CronSchedule::every_with_anchor(every_ms, anchor_ms),
    }
    .map_err(|_| crate::cron::InvalidCronCommand)
}

pub(crate) struct OpenClawCronExecutionWaiter(openclaw::port::CronExecutionAdmission);

impl crate::cron::CronExecutionWaiter for OpenClawCronExecutionWaiter {
    fn await_terminal(
        self: Box<Self>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = crate::cron::CronExecutionTerminalStatus> + Send>,
    > {
        Box::pin(async move {
            project_cron_execution_status(
                openclaw::port::await_cron_execution(self.0, cancellation).await,
            )
        })
    }
}

pub(crate) fn project_cron_execution_admission(
    admission: openclaw::port::CronExecutionAdmission,
) -> Result<crate::cron::CronExecutionAdmission, ()> {
    crate::cron::CronExecutionAdmission::new(
        admission.run_id().to_owned(),
        OpenClawCronExecutionWaiter(admission),
    )
    .map_err(|_| ())
}

pub(crate) fn project_cron_history_receipt(
    receipt: openclaw::gateway::wire::CronRunHistoryEntry,
) -> crate::cron::CronRunHistoryReceipt {
    crate::cron::CronRunHistoryReceipt::new(receipt.job_id, receipt.session_id, receipt.session_key)
}

pub(crate) fn project_cron_history_failure(
    failure: openclaw::port::CronHistoryReadFailure,
) -> crate::cron::CronRunHistoryFailure {
    match failure {
        openclaw::port::CronHistoryReadFailure::Rejected => {
            crate::cron::CronRunHistoryFailure::Rejected
        }
        openclaw::port::CronHistoryReadFailure::Protocol => {
            crate::cron::CronRunHistoryFailure::Protocol
        }
        openclaw::port::CronHistoryReadFailure::Deadline => {
            crate::cron::CronRunHistoryFailure::Deadline
        }
        openclaw::port::CronHistoryReadFailure::Unavailable => {
            crate::cron::CronRunHistoryFailure::Unavailable
        }
    }
}

pub(crate) fn project_cron_trigger_result(
    status: openclaw::port::CronTriggerOutcome,
) -> crate::cron::CronTriggerResult {
    match status {
        openclaw::port::CronTriggerOutcome::Accepted => crate::cron::CronTriggerResult::Accepted,
        openclaw::port::CronTriggerOutcome::Skipped(disposition) => {
            crate::cron::CronTriggerResult::Skipped(project_cron_trigger_skip_reason(disposition))
        }
        openclaw::port::CronTriggerOutcome::OutcomeUnknown => {
            crate::cron::CronTriggerResult::OutcomeUnknown
        }
    }
}

pub(crate) fn project_cron_trigger_skip_reason(
    disposition: openclaw::port::CronRunDisposition,
) -> crate::cron::CronTriggerSkipReason {
    match disposition {
        openclaw::port::CronRunDisposition::AlreadyRunning => {
            crate::cron::CronTriggerSkipReason::AlreadyRunning
        }
        openclaw::port::CronRunDisposition::NotDue => crate::cron::CronTriggerSkipReason::NotDue,
        openclaw::port::CronRunDisposition::InvalidSpec => {
            crate::cron::CronTriggerSkipReason::InvalidSpec
        }
        openclaw::port::CronRunDisposition::Disabled => {
            crate::cron::CronTriggerSkipReason::Disabled
        }
        openclaw::port::CronRunDisposition::Stopped => crate::cron::CronTriggerSkipReason::Stopped,
    }
}

pub(crate) fn project_cron_execution_status(
    status: openclaw::port::CronExecutionStatus,
) -> crate::cron::CronExecutionTerminalStatus {
    match status {
        openclaw::port::CronExecutionStatus::Succeeded => {
            crate::cron::CronExecutionTerminalStatus::Succeeded
        }
        openclaw::port::CronExecutionStatus::Failed => {
            crate::cron::CronExecutionTerminalStatus::Failed
        }
        openclaw::port::CronExecutionStatus::Skipped => {
            crate::cron::CronExecutionTerminalStatus::Skipped
        }
        openclaw::port::CronExecutionStatus::Cancelled => {
            crate::cron::CronExecutionTerminalStatus::Cancelled
        }
        openclaw::port::CronExecutionStatus::OutcomeUnknown => {
            crate::cron::CronExecutionTerminalStatus::OutcomeUnknown
        }
    }
}

pub(crate) fn project_cron_mutation(
    outcome: openclaw::port::CronMutationOutcome<openclaw::gateway::wire::CronJob>,
) -> crate::cron::CronJobMutationOutcome {
    match outcome {
        openclaw::port::CronMutationOutcome::Applied(job) => {
            crate::cron::CronJobMutationOutcome::Applied(Box::new(project_cron_job(job)))
        }
        openclaw::port::CronMutationOutcome::Rejected => {
            crate::cron::CronJobMutationOutcome::Rejected
        }
        openclaw::port::CronMutationOutcome::OutcomeUnknown => {
            crate::cron::CronJobMutationOutcome::OutcomeUnknown
        }
    }
}

pub(crate) fn project_cron_delete(
    outcome: openclaw::port::CronMutationOutcome<openclaw::gateway::wire::CronRemoved>,
) -> crate::cron::CronDeleteOutcome {
    match outcome {
        openclaw::port::CronMutationOutcome::Applied(receipt) => {
            crate::cron::CronDeleteOutcome::Applied(crate::cron::CronRemovedView {
                removed: receipt.removed,
            })
        }
        openclaw::port::CronMutationOutcome::Rejected => crate::cron::CronDeleteOutcome::Rejected,
        openclaw::port::CronMutationOutcome::OutcomeUnknown => {
            crate::cron::CronDeleteOutcome::OutcomeUnknown
        }
    }
}

pub(crate) fn project_cron_list(
    jobs: openclaw::gateway::wire::CronJobs,
) -> crate::cron::CronListView {
    crate::cron::CronListView {
        jobs: jobs.jobs.into_iter().map(project_cron_job).collect(),
    }
}

pub(crate) fn project_cron_job(job: openclaw::gateway::wire::CronJob) -> crate::cron::CronJobView {
    let state = job.state().clone();
    crate::cron::CronJobView {
        id: job.id,
        name: job.name,
        agent_id: job.agent_id,
        message: job.message,
        model: job.model,
        schedule: project_cron_schedule(job.schedule),
        delivery: project_cron_delivery(job.delivery),
        enabled: job.enabled,
        created_at_ms: job.created_at_ms,
        updated_at_ms: job.updated_at_ms,
        state: crate::cron::CronJobStateView {
            next_run_at_ms: state.next_run_at_ms,
            running_at_ms: state.running_at_ms,
            last_run_at_ms: state.last_run_at_ms,
            last_run_status: state.last_run_status.map(project_cron_run_status),
            last_error: state.last_error.clone(),
            last_duration_ms: state.last_duration_ms,
        },
    }
}

pub(crate) fn project_cron_schedule(
    schedule: openclaw::gateway::wire::CronScheduleView,
) -> crate::cron::CronScheduleView {
    match schedule {
        openclaw::gateway::wire::CronScheduleView::At { at } => {
            crate::cron::CronScheduleView::At { at }
        }
        openclaw::gateway::wire::CronScheduleView::Every {
            every_ms,
            anchor_ms,
        } => crate::cron::CronScheduleView::Every {
            every_ms,
            anchor_ms,
        },
        openclaw::gateway::wire::CronScheduleView::Cron { expr, tz } => {
            crate::cron::CronScheduleView::Cron { expr, tz }
        }
    }
}

pub(crate) fn project_cron_delivery(
    delivery: openclaw::gateway::wire::CronDeliveryView,
) -> crate::cron::CronDeliveryView {
    match delivery {
        openclaw::gateway::wire::CronDeliveryView::None => crate::cron::CronDeliveryView::None,
        openclaw::gateway::wire::CronDeliveryView::Announce {
            channel,
            to,
            account_id,
        } => crate::cron::CronDeliveryView::Announce {
            channel,
            to,
            account_id,
        },
    }
}

pub(crate) fn project_cron_run_status(
    status: openclaw::gateway::wire::CronRunStatus,
) -> crate::cron::CronRunStatusView {
    match status {
        openclaw::gateway::wire::CronRunStatus::Ok => crate::cron::CronRunStatusView::Ok,
        openclaw::gateway::wire::CronRunStatus::Error => crate::cron::CronRunStatusView::Error,
        openclaw::gateway::wire::CronRunStatus::Skipped => crate::cron::CronRunStatusView::Skipped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_structured_schedules_to_gateway_commands() {
        let at_command = crate::cron::CronCreateCommand::try_new(
            "Cron name".into(),
            "main".into(),
            "Scheduled message".into(),
            None,
            crate::cron::CronScheduleCommand::At {
                at: "2026-09-04T09:00:00.000Z".into(),
            },
            crate::cron::CronDeliveryCommand::None,
            true,
        )
        .unwrap();
        let at_gateway =
            serde_json::to_value(cron_create_into_gateway(at_command).unwrap()).unwrap();
        assert_eq!(
            at_gateway["schedule"],
            serde_json::json!({ "kind": "at", "at": "2026-09-04T09:00:00.000Z" })
        );

        let every_command = crate::cron::CronUpdateCommand::try_new(
            "cron-job".into(),
            None,
            None,
            None,
            None,
            Some(crate::cron::CronScheduleCommand::Every {
                every_ms: 60_000,
                anchor_ms: Some(1_000),
            }),
            None,
            None,
        )
        .unwrap();
        let (job_id, patch, expected_config_revision) =
            cron_update_into_gateway(every_command).unwrap();
        assert_eq!(job_id, "cron-job");
        assert_eq!(expected_config_revision, None);
        let every_gateway = serde_json::to_value(patch).unwrap();
        assert_eq!(
            every_gateway["schedule"],
            serde_json::json!({ "kind": "every", "everyMs": 60_000, "anchorMs": 1_000 })
        );
    }
}
