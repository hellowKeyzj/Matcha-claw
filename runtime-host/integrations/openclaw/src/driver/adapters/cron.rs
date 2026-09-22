pub(crate) fn cron_create_into_gateway(
    command: ::cron::CronCreateCommand,
) -> Result<crate::gateway::wire::CronJobCreate, ::cron::InvalidCronCommand> {
    let job = crate::gateway::wire::CronJobCreate::isolated_agent_turn(
        command.name,
        cron_schedule_into_gateway(command.schedule)?,
        crate::gateway::wire::CronWakeMode::NextHeartbeat,
        command.message,
    )
    .map_err(|_| ::cron::InvalidCronCommand)?
    .with_agent_id(command.agent_id)
    .map_err(|_| ::cron::InvalidCronCommand)?
    .with_model(command.model)
    .map_err(|_| ::cron::InvalidCronCommand)?
    .with_enabled(command.enabled);
    match command.delivery {
        ::cron::CronDeliveryCommand::None => Ok(job.with_no_delivery()),
        ::cron::CronDeliveryCommand::Announce {
            channel,
            to,
            account_id,
        } => job
            .with_announcement_delivery(channel, to, account_id)
            .map_err(|_| ::cron::InvalidCronCommand),
    }
}

pub(crate) fn cron_update_into_gateway(
    command: ::cron::CronUpdateCommand,
) -> Result<(String, crate::gateway::wire::CronJobPatch, Option<String>), ::cron::InvalidCronCommand>
{
    let schedule = command
        .schedule
        .map(cron_schedule_into_gateway)
        .transpose()?;
    let mut update = crate::gateway::wire::CronJobUpdate::new(
        command.name,
        command.agent_id,
        command.message,
        command.model,
        schedule,
        command.enabled,
    )
    .map_err(|_| ::cron::InvalidCronCommand)?;
    if let Some(delivery) = command.delivery {
        update = match delivery {
            ::cron::CronDeliveryCommand::None => update.with_no_delivery(),
            ::cron::CronDeliveryCommand::Announce {
                channel,
                to,
                account_id,
            } => update.with_announcement_delivery(channel, to, account_id),
        }
        .map_err(|_| ::cron::InvalidCronCommand)?;
    }
    Ok((
        command.job_id,
        crate::gateway::wire::CronJobPatch::update(update),
        command.expected_config_revision,
    ))
}

pub(crate) fn cron_schedule_into_gateway(
    schedule: ::cron::CronScheduleCommand,
) -> Result<crate::gateway::wire::CronSchedule, ::cron::InvalidCronCommand> {
    match schedule {
        ::cron::CronScheduleCommand::Cron { expr, tz: None } => {
            crate::gateway::wire::CronSchedule::cron(expr)
        }
        ::cron::CronScheduleCommand::Cron { expr, tz } => {
            crate::gateway::wire::CronSchedule::cron_with_options(expr, tz, None)
        }
        ::cron::CronScheduleCommand::At { at } => crate::gateway::wire::CronSchedule::at(at),
        ::cron::CronScheduleCommand::Every {
            every_ms,
            anchor_ms,
        } => crate::gateway::wire::CronSchedule::every_with_anchor(every_ms, anchor_ms),
    }
    .map_err(|_| ::cron::InvalidCronCommand)
}

pub(crate) struct OpenClawCronExecutionWaiter(crate::port::CronExecutionAdmission);

impl ::cron::CronExecutionWaiter for OpenClawCronExecutionWaiter {
    fn await_terminal(
        self: Box<Self>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = ::cron::CronExecutionTerminalStatus> + Send>,
    > {
        Box::pin(async move {
            project_cron_execution_status(
                crate::port::await_cron_execution(self.0, cancellation).await,
            )
        })
    }
}

pub(crate) fn project_cron_execution_admission(
    admission: crate::port::CronExecutionAdmission,
) -> Result<::cron::CronExecutionAdmission, ()> {
    ::cron::CronExecutionAdmission::new(
        admission.run_id().to_owned(),
        OpenClawCronExecutionWaiter(admission),
    )
    .map_err(|_| ())
}

pub(crate) fn project_cron_history_receipt(
    receipt: crate::gateway::wire::CronRunHistoryEntry,
) -> ::cron::CronRunHistoryReceipt {
    ::cron::CronRunHistoryReceipt::new(receipt.job_id, receipt.session_id, receipt.session_key)
}

pub(crate) fn project_cron_history_failure(
    failure: crate::port::CronHistoryReadFailure,
) -> ::cron::CronRunHistoryFailure {
    match failure {
        crate::port::CronHistoryReadFailure::Rejected => ::cron::CronRunHistoryFailure::Rejected,
        crate::port::CronHistoryReadFailure::Protocol => ::cron::CronRunHistoryFailure::Protocol,
        crate::port::CronHistoryReadFailure::Deadline => ::cron::CronRunHistoryFailure::Deadline,
        crate::port::CronHistoryReadFailure::Unavailable => {
            ::cron::CronRunHistoryFailure::Unavailable
        }
    }
}

pub(crate) fn project_cron_trigger_result(
    status: crate::port::CronTriggerOutcome,
) -> ::cron::CronTriggerResult {
    match status {
        crate::port::CronTriggerOutcome::Accepted => ::cron::CronTriggerResult::Accepted,
        crate::port::CronTriggerOutcome::Skipped(disposition) => {
            ::cron::CronTriggerResult::Skipped(project_cron_trigger_skip_reason(disposition))
        }
        crate::port::CronTriggerOutcome::OutcomeUnknown => {
            ::cron::CronTriggerResult::OutcomeUnknown
        }
    }
}

pub(crate) fn project_cron_trigger_skip_reason(
    disposition: crate::port::CronRunDisposition,
) -> ::cron::CronTriggerSkipReason {
    match disposition {
        crate::port::CronRunDisposition::AlreadyRunning => {
            ::cron::CronTriggerSkipReason::AlreadyRunning
        }
        crate::port::CronRunDisposition::NotDue => ::cron::CronTriggerSkipReason::NotDue,
        crate::port::CronRunDisposition::InvalidSpec => ::cron::CronTriggerSkipReason::InvalidSpec,
        crate::port::CronRunDisposition::Disabled => ::cron::CronTriggerSkipReason::Disabled,
        crate::port::CronRunDisposition::Stopped => ::cron::CronTriggerSkipReason::Stopped,
    }
}

pub(crate) fn project_cron_execution_status(
    status: crate::port::CronExecutionStatus,
) -> ::cron::CronExecutionTerminalStatus {
    match status {
        crate::port::CronExecutionStatus::Succeeded => {
            ::cron::CronExecutionTerminalStatus::Succeeded
        }
        crate::port::CronExecutionStatus::Failed => ::cron::CronExecutionTerminalStatus::Failed,
        crate::port::CronExecutionStatus::Skipped => ::cron::CronExecutionTerminalStatus::Skipped,
        crate::port::CronExecutionStatus::Cancelled => {
            ::cron::CronExecutionTerminalStatus::Cancelled
        }
        crate::port::CronExecutionStatus::OutcomeUnknown => {
            ::cron::CronExecutionTerminalStatus::OutcomeUnknown
        }
    }
}

pub(crate) fn project_cron_mutation(
    outcome: crate::port::CronMutationOutcome<crate::gateway::wire::CronJob>,
) -> ::cron::CronJobMutationOutcome {
    match outcome {
        crate::port::CronMutationOutcome::Applied(job) => {
            ::cron::CronJobMutationOutcome::Applied(Box::new(project_cron_job(job)))
        }
        crate::port::CronMutationOutcome::Rejected => ::cron::CronJobMutationOutcome::Rejected,
        crate::port::CronMutationOutcome::OutcomeUnknown => {
            ::cron::CronJobMutationOutcome::OutcomeUnknown
        }
    }
}

pub(crate) fn project_cron_delete(
    outcome: crate::port::CronMutationOutcome<crate::gateway::wire::CronRemoved>,
) -> ::cron::CronDeleteOutcome {
    match outcome {
        crate::port::CronMutationOutcome::Applied(receipt) => {
            ::cron::CronDeleteOutcome::Applied(::cron::CronRemovedView {
                removed: receipt.removed,
            })
        }
        crate::port::CronMutationOutcome::Rejected => ::cron::CronDeleteOutcome::Rejected,
        crate::port::CronMutationOutcome::OutcomeUnknown => {
            ::cron::CronDeleteOutcome::OutcomeUnknown
        }
    }
}

pub(crate) fn project_cron_list(jobs: crate::gateway::wire::CronJobs) -> ::cron::CronListView {
    ::cron::CronListView {
        jobs: jobs.jobs.into_iter().map(project_cron_job).collect(),
    }
}

pub(crate) fn project_cron_job(job: crate::gateway::wire::CronJob) -> ::cron::CronJobView {
    let state = job.state().clone();
    ::cron::CronJobView {
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
        state: ::cron::CronJobStateView {
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
    schedule: crate::gateway::wire::CronScheduleView,
) -> ::cron::CronScheduleView {
    match schedule {
        crate::gateway::wire::CronScheduleView::At { at } => ::cron::CronScheduleView::At { at },
        crate::gateway::wire::CronScheduleView::Every {
            every_ms,
            anchor_ms,
        } => ::cron::CronScheduleView::Every {
            every_ms,
            anchor_ms,
        },
        crate::gateway::wire::CronScheduleView::Cron { expr, tz } => {
            ::cron::CronScheduleView::Cron { expr, tz }
        }
    }
}

pub(crate) fn project_cron_delivery(
    delivery: crate::gateway::wire::CronDeliveryView,
) -> ::cron::CronDeliveryView {
    match delivery {
        crate::gateway::wire::CronDeliveryView::None => ::cron::CronDeliveryView::None,
        crate::gateway::wire::CronDeliveryView::Announce {
            channel,
            to,
            account_id,
        } => ::cron::CronDeliveryView::Announce {
            channel,
            to,
            account_id,
        },
    }
}

pub(crate) fn project_cron_run_status(
    status: crate::gateway::wire::CronRunStatus,
) -> ::cron::CronRunStatusView {
    match status {
        crate::gateway::wire::CronRunStatus::Ok => ::cron::CronRunStatusView::Ok,
        crate::gateway::wire::CronRunStatus::Error => ::cron::CronRunStatusView::Error,
        crate::gateway::wire::CronRunStatus::Skipped => ::cron::CronRunStatusView::Skipped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_structured_schedules_to_gateway_commands() {
        let at_command = ::cron::CronCreateCommand::try_new(
            "Cron name".into(),
            "main".into(),
            "Scheduled message".into(),
            None,
            ::cron::CronScheduleCommand::At {
                at: "2026-09-04T09:00:00.000Z".into(),
            },
            ::cron::CronDeliveryCommand::None,
            true,
        )
        .unwrap();
        let at_gateway =
            serde_json::to_value(cron_create_into_gateway(at_command).unwrap()).unwrap();
        assert_eq!(
            at_gateway["schedule"],
            serde_json::json!({ "kind": "at", "at": "2026-09-04T09:00:00.000Z" })
        );

        let every_command = ::cron::CronUpdateCommand::try_new(
            "cron-job".into(),
            None,
            None,
            None,
            None,
            Some(::cron::CronScheduleCommand::Every {
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
