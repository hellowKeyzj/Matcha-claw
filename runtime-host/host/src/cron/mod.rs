const MAX_JOB_ID_BYTES: usize = 4 * 1024;
const MAX_RUN_ID_BYTES: usize = 4 * 1024;
const MAX_NAME_BYTES: usize = 4 * 1024;
const MAX_AGENT_ID_BYTES: usize = 4 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_MODEL_BYTES: usize = 4 * 1024;
const MAX_SCHEDULE_BYTES: usize = 4 * 1024;
const MAX_DELIVERY_BYTES: usize = 4 * 1024;
const MAX_DATE_TIMESTAMP_MS: u64 = 8_640_000_000_000_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronCreateCommand {
    pub(crate) name: String,
    pub(crate) agent_id: String,
    pub(crate) message: String,
    pub(crate) model: Option<String>,
    pub(crate) schedule: CronScheduleCommand,
    pub(crate) delivery: CronDeliveryCommand,
    pub(crate) enabled: bool,
}

impl CronCreateCommand {
    pub(crate) fn try_new(
        name: String,
        agent_id: String,
        message: String,
        model: Option<String>,
        schedule: CronScheduleCommand,
        delivery: CronDeliveryCommand,
        enabled: bool,
    ) -> Result<Self, InvalidCronCommand> {
        if !valid_text(&name, MAX_NAME_BYTES)
            || !valid_text(&agent_id, MAX_AGENT_ID_BYTES)
            || !valid_text(&message, MAX_MESSAGE_BYTES)
            || model
                .as_deref()
                .is_some_and(|value| !valid_text(value, MAX_MODEL_BYTES))
            || !schedule.is_valid()
            || !delivery.is_valid()
        {
            return Err(InvalidCronCommand);
        }
        Ok(Self {
            name,
            agent_id,
            message,
            model,
            schedule,
            delivery,
            enabled,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronUpdateCommand {
    pub(crate) job_id: String,
    pub(crate) expected_config_revision: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) agent_id: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) model: Option<Option<String>>,
    pub(crate) schedule: Option<CronScheduleCommand>,
    pub(crate) delivery: Option<CronDeliveryCommand>,
    pub(crate) enabled: Option<bool>,
}

impl CronUpdateCommand {
    pub(crate) fn try_new(
        job_id: String,
        name: Option<String>,
        agent_id: Option<String>,
        message: Option<String>,
        model: Option<Option<String>>,
        schedule: Option<CronScheduleCommand>,
        delivery: Option<CronDeliveryCommand>,
        enabled: Option<bool>,
    ) -> Result<Self, InvalidCronCommand> {
        if !valid_job_id(&job_id)
            || name
                .as_deref()
                .is_some_and(|value| !valid_text(value, MAX_NAME_BYTES))
            || agent_id
                .as_deref()
                .is_some_and(|value| !valid_text(value, MAX_AGENT_ID_BYTES))
            || message
                .as_deref()
                .is_some_and(|value| !valid_text(value, MAX_MESSAGE_BYTES))
            || model
                .as_ref()
                .and_then(|value| value.as_deref())
                .is_some_and(|value| !valid_text(value, MAX_MODEL_BYTES))
            || schedule.as_ref().is_some_and(|value| !value.is_valid())
            || delivery.as_ref().is_some_and(|value| !value.is_valid())
            || (name.is_none()
                && agent_id.is_none()
                && message.is_none()
                && model.is_none()
                && schedule.is_none()
                && delivery.is_none()
                && enabled.is_none())
        {
            return Err(InvalidCronCommand);
        }
        Ok(Self {
            job_id,
            expected_config_revision: None,
            name,
            agent_id,
            message,
            model,
            schedule,
            delivery,
            enabled,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronDeleteCommand {
    pub(crate) job_id: String,
}

impl CronDeleteCommand {
    pub(crate) fn try_new(job_id: String) -> Result<Self, InvalidCronCommand> {
        valid_job_id(&job_id)
            .then_some(Self { job_id })
            .ok_or(InvalidCronCommand)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CronScheduleCommand {
    Cron {
        expr: String,
        tz: Option<String>,
    },
    At {
        at: String,
    },
    Every {
        every_ms: u64,
        anchor_ms: Option<u64>,
    },
}

impl CronScheduleCommand {
    pub(crate) fn cron(expr: String) -> Self {
        Self::Cron { expr, tz: None }
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::Cron { expr, tz } => {
                valid_cron_expression(expr)
                    && tz
                        .as_deref()
                        .is_none_or(|value| valid_text(value, MAX_SCHEDULE_BYTES))
            }
            Self::At { at } => valid_text(at, MAX_SCHEDULE_BYTES),
            Self::Every {
                every_ms,
                anchor_ms,
            } => {
                (1..=MAX_DATE_TIMESTAMP_MS).contains(every_ms)
                    && anchor_ms.is_none_or(|value| value <= MAX_DATE_TIMESTAMP_MS)
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CronDeliveryCommand {
    None,
    Announce {
        channel: String,
        to: String,
        account_id: String,
    },
}

impl CronDeliveryCommand {
    fn is_valid(&self) -> bool {
        match self {
            Self::None => true,
            Self::Announce {
                channel,
                to,
                account_id,
            } => {
                valid_text(channel, MAX_DELIVERY_BYTES)
                    && valid_text(to, MAX_DELIVERY_BYTES)
                    && valid_text(account_id, MAX_DELIVERY_BYTES)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidCronCommand;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronHistoryCommand {
    job_id: String,
    run_session_id: Option<String>,
    limit: u64,
}

impl CronHistoryCommand {
    pub(crate) fn try_new(session_key: String, limit: u64) -> Result<Self, InvalidCronCommand> {
        let (job_id, run_session_id) =
            parse_history_target(&session_key).ok_or(InvalidCronCommand)?;
        Ok(Self {
            job_id,
            run_session_id,
            limit,
        })
    }

    pub(crate) fn job_id(&self) -> &str {
        &self.job_id
    }

    pub(crate) fn limit(&self) -> u64 {
        self.limit
    }

    pub(crate) fn canonical_session_key(
        &self,
        receipts: impl IntoIterator<Item = CronRunHistoryReceipt>,
    ) -> Option<String> {
        let mut session_key = None;
        for receipt in receipts {
            if receipt.job_id != self.job_id
                || !self.matches_run_session(receipt.session_id.as_deref())
            {
                continue;
            }
            let Some(candidate) = receipt.session_key else {
                continue;
            };
            match &session_key {
                Some(existing) if existing != &candidate => return None,
                Some(_) => {}
                None => session_key = Some(candidate),
            }
        }
        session_key
    }

    fn matches_run_session(&self, session_id: Option<&str>) -> bool {
        match &self.run_session_id {
            Some(expected) => session_id == Some(expected.as_str()),
            None => true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronRunHistoryReceipt {
    pub(crate) job_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) session_key: Option<String>,
}

impl CronRunHistoryReceipt {
    pub(crate) fn new(
        job_id: String,
        session_id: Option<String>,
        session_key: Option<String>,
    ) -> Self {
        Self {
            job_id,
            session_id,
            session_key,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CronRunHistoryFailure {
    Rejected,
    Protocol,
    Deadline,
    Unavailable,
}

pub(crate) trait CronExecutionWaiter: Send {
    fn await_terminal(
        self: Box<Self>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = CronExecutionTerminalStatus> + Send>>;
}

pub(crate) struct CronExecutionAdmission {
    run_id: String,
    waiter: Box<dyn CronExecutionWaiter>,
}

impl CronExecutionAdmission {
    pub(crate) fn new(
        run_id: String,
        waiter: impl CronExecutionWaiter + 'static,
    ) -> Result<Self, InvalidCronCommand> {
        if !valid_text(&run_id, MAX_RUN_ID_BYTES) {
            return Err(InvalidCronCommand);
        }
        Ok(Self {
            run_id,
            waiter: Box::new(waiter),
        })
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) async fn await_terminal(
        self,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> CronExecutionTerminalStatus {
        self.waiter.await_terminal(cancellation).await
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronHistoryView {
    pub(crate) messages: Vec<CronHistoryMessageView>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronHistoryMessageView {
    pub(crate) role: CronHistoryRole,
    pub(crate) text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CronHistoryRole {
    User,
    Assistant,
}

#[derive(Debug)]
pub(crate) enum CronHistoryOutcome {
    Loaded(CronHistoryView),
    Rejected,
    Protocol,
    Unavailable,
    Deadline,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronListView {
    pub(crate) jobs: Vec<CronJobView>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronJobView {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) agent_id: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) schedule: CronScheduleView,
    pub(crate) delivery: CronDeliveryView,
    pub(crate) enabled: bool,
    pub(crate) created_at_ms: u64,
    pub(crate) updated_at_ms: u64,
    pub(crate) state: CronJobStateView,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CronScheduleView {
    At {
        at: String,
    },
    Every {
        every_ms: u64,
        anchor_ms: Option<u64>,
    },
    Cron {
        expr: String,
        tz: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CronDeliveryView {
    None,
    Announce {
        channel: String,
        to: String,
        account_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronJobStateView {
    pub(crate) next_run_at_ms: Option<u64>,
    pub(crate) running_at_ms: Option<u64>,
    pub(crate) last_run_at_ms: Option<u64>,
    pub(crate) last_run_status: Option<CronRunStatusView>,
    pub(crate) last_error: Option<String>,
    pub(crate) last_duration_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CronRunStatusView {
    Ok,
    Error,
    Skipped,
}

#[derive(Debug)]
pub(crate) enum CronListOutcome {
    Listed(CronListView),
    Unavailable,
    Rejected,
    Protocol,
}

#[derive(Debug)]
pub(crate) enum CronJobMutationOutcome {
    Applied(Box<CronJobView>),
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CronRemovedView {
    pub(crate) removed: bool,
}

#[derive(Debug)]
pub(crate) enum CronDeleteOutcome {
    Applied(CronRemovedView),
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CronTriggerResult {
    Accepted,
    Skipped(CronTriggerSkipReason),
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CronTriggerSkipReason {
    AlreadyRunning,
    NotDue,
    InvalidSpec,
    Disabled,
    Stopped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CronExecutionTerminalStatus {
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    OutcomeUnknown,
}

fn parse_history_target(value: &str) -> Option<(String, Option<String>)> {
    let parts: Vec<_> = value.split(':').collect();
    let cron_index = if parts.first() == Some(&"agent") {
        2
    } else {
        1
    };
    if parts.get(cron_index) != Some(&"cron") {
        return None;
    }
    let agent_id = if cron_index == 2 {
        parts.get(1)
    } else {
        parts.first()
    }?;
    if !valid_text(agent_id, MAX_JOB_ID_BYTES) {
        return None;
    }
    let job_id = parts.get(cron_index + 1)?;
    if !valid_job_id(job_id) {
        return None;
    }
    match parts.len() {
        length if length == cron_index + 2 => Some(((*job_id).to_owned(), None)),
        length
            if length == cron_index + 4
                && parts.get(cron_index + 2) == Some(&"run")
                && valid_text(parts[cron_index + 3], MAX_JOB_ID_BYTES) =>
        {
            Some(((*job_id).to_owned(), Some(parts[cron_index + 3].to_owned())))
        }
        _ => None,
    }
}

fn valid_job_id(value: &str) -> bool {
    valid_text(value, MAX_JOB_ID_BYTES) && !value.contains(['/', '\\'])
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.contains('\0')
}

fn valid_cron_expression(value: &str) -> bool {
    let fields = value.split_ascii_whitespace().count();
    valid_text(value, MAX_SCHEDULE_BYTES)
        && (fields == 5 || fields == 6)
        && !value.contains(['\r', '\n'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_only_fully_valid_isolated_agent_turn_commands() {
        assert!(
            CronCreateCommand::try_new(
                "Cron name".into(),
                "main".into(),
                "Scheduled message".into(),
                None,
                CronScheduleCommand::cron("0 9 * * 1".into()),
                CronDeliveryCommand::Announce {
                    channel: "telegram".into(),
                    to: "recipient".into(),
                    account_id: "account".into(),
                },
                true,
            )
            .is_ok()
        );

        assert!(
            CronCreateCommand::try_new(
                "Cron name".into(),
                "main".into(),
                "Scheduled message".into(),
                None,
                CronScheduleCommand::cron("not a cron".into()),
                CronDeliveryCommand::None,
                true,
            )
            .is_err()
        );
    }

    #[test]
    fn update_rejects_empty_or_malformed_commands() {
        assert!(CronUpdateCommand::try_new(
            "cron-job".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .is_err());
        assert!(
            CronUpdateCommand::try_new(
                "cron/job".into(),
                None,
                None,
                None,
                None,
                None,
                None,
                Some(true),
            )
            .is_err()
        );
    }

    #[test]
    fn outcomes_preserve_mutation_ambiguity() {
        assert!(matches!(
            CronJobMutationOutcome::OutcomeUnknown,
            CronJobMutationOutcome::OutcomeUnknown
        ));
        assert!(matches!(
            CronDeleteOutcome::OutcomeUnknown,
            CronDeleteOutcome::OutcomeUnknown
        ));
    }
}
