use openclaw::{
    gateway::wire::{
        CronJob, CronJobCreate, CronJobPatch, CronJobUpdate, CronJobs, CronRemoved, CronSchedule,
        CronWakeMode,
    },
    port::{CronMutationOutcome, CronReadFailure},
};

const MAX_JOB_ID_BYTES: usize = 4 * 1024;
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

    pub(crate) fn into_gateway(self) -> Result<CronJobCreate, InvalidCronCommand> {
        let job = CronJobCreate::isolated_agent_turn(
            self.name,
            self.schedule.into_gateway()?,
            CronWakeMode::NextHeartbeat,
            self.message,
        )
        .map_err(|_| InvalidCronCommand)?
        .with_agent_id(self.agent_id)
        .map_err(|_| InvalidCronCommand)?
        .with_model(self.model)
        .map_err(|_| InvalidCronCommand)?
        .with_enabled(self.enabled);
        match self.delivery {
            CronDeliveryCommand::None => Ok(job.with_no_delivery()),
            CronDeliveryCommand::Announce {
                channel,
                to,
                account_id,
            } => job
                .with_announcement_delivery(channel, to, account_id)
                .map_err(|_| InvalidCronCommand),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronUpdateCommand {
    pub(crate) job_id: String,
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
            name,
            agent_id,
            message,
            model,
            schedule,
            delivery,
            enabled,
        })
    }

    pub(crate) fn job_id(&self) -> &str {
        &self.job_id
    }

    pub(crate) fn into_gateway(self) -> Result<(String, CronJobPatch), InvalidCronCommand> {
        let schedule = self
            .schedule
            .map(CronScheduleCommand::into_gateway)
            .transpose()?;
        let mut update = CronJobUpdate::new(
            self.name,
            self.agent_id,
            self.message,
            self.model,
            schedule,
            self.enabled,
        )
        .map_err(|_| InvalidCronCommand)?;
        if let Some(delivery) = self.delivery {
            update = match delivery {
                CronDeliveryCommand::None => update.with_no_delivery(),
                CronDeliveryCommand::Announce {
                    channel,
                    to,
                    account_id,
                } => update.with_announcement_delivery(channel, to, account_id),
            }
            .map_err(|_| InvalidCronCommand)?;
        }
        Ok((self.job_id, CronJobPatch::update(update)))
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

    pub(crate) fn job_id(&self) -> &str {
        &self.job_id
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

    fn into_gateway(self) -> Result<CronSchedule, InvalidCronCommand> {
        match self {
            Self::Cron { expr, tz: None } => CronSchedule::cron(expr),
            Self::Cron { expr, tz } => CronSchedule::cron_with_options(expr, tz, None),
            Self::At { at } => CronSchedule::at(at),
            Self::Every {
                every_ms,
                anchor_ms,
            } => CronSchedule::every_with_anchor(every_ms, anchor_ms),
        }
        .map_err(|_| InvalidCronCommand)
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

    pub(crate) fn matches_run_session(&self, session_id: Option<&str>) -> bool {
        match &self.run_session_id {
            Some(expected) => session_id == Some(expected.as_str()),
            None => true,
        }
    }
}

#[derive(Debug)]
pub(crate) enum CronHistoryOutcome {
    Loaded(openclaw::session::protocol::ChatHistoryResult),
    Rejected,
    Protocol,
    Unavailable,
    Deadline,
}

#[derive(Debug)]
pub(crate) enum CronListOutcome {
    Listed(CronJobs),
    Unavailable,
    Rejected,
    Protocol,
}

#[derive(Debug)]
pub(crate) enum CronJobMutationOutcome {
    Applied(Box<CronJob>),
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

#[derive(Debug)]
pub(crate) enum CronDeleteOutcome {
    Applied(CronRemoved),
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronBrokerContext {
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) owner: String,
    pub(crate) target: serde_json::Value,
    pub(crate) input: serde_json::Value,
    pub(crate) expected_revision: Option<String>,
}

#[derive(Debug)]
pub(crate) struct CronBrokerRequest {
    pub(crate) request_id: String,
    pub(crate) operation_id: String,
    pub(crate) context: CronBrokerContext,
    pub(crate) payload_hash: String,
    pub(crate) operation: CronBrokerOperation,
}

#[derive(Debug)]
pub(crate) enum CronBrokerOperation {
    List,
    History {
        command: CronHistoryCommand,
    },
    Create {
        command: CronCreateCommand,
    },
    Update {
        command: CronUpdateCommand,
        expected_revision: String,
    },
    Delete {
        command: CronDeleteCommand,
        expected_revision: String,
    },
}

#[derive(Debug)]
pub(crate) enum CronBrokerResult {
    List(CronListOutcome),
    History(CronHistoryOutcome),
    Job(CronJobMutationOutcome),
    Delete(CronDeleteOutcome),
}

#[derive(Debug)]
pub(crate) enum CronBrokerOutcome {
    Applied(CronBrokerResult),
    Rejected {
        code: &'static str,
        message: &'static str,
    },
    Conflict {
        code: &'static str,
        message: &'static str,
    },
    Unknown {
        code: &'static str,
        message: &'static str,
    },
    Unavailable {
        code: &'static str,
        message: &'static str,
    },
}

pub(crate) fn canonical_json(value: &serde_json::Value) -> String {
    platform::exchange::canonical::encode(value)
}

impl CronBrokerRequest {
    pub(crate) fn scope(&self) -> &'static str {
        match self.operation {
            CronBrokerOperation::List | CronBrokerOperation::History { .. } => "cron:read",
            CronBrokerOperation::Create { .. }
            | CronBrokerOperation::Update { .. }
            | CronBrokerOperation::Delete { .. } => "cron:write",
        }
    }

    pub(crate) fn context_hash(&self) -> String {
        let value = serde_json::json!({
            "version": 1,
            "requestId": self.request_id,
            "operationId": self.operation_id,
            "operation": match &self.operation {
                CronBrokerOperation::List => "list",
                CronBrokerOperation::History { .. } => "history",
                CronBrokerOperation::Create { .. } => "create",
                CronBrokerOperation::Update { .. } => "update",
                CronBrokerOperation::Delete { .. } => "delete",
            },
            "sessionId": self.context.session_id,
            "cwd": self.context.cwd,
            "owner": self.context.owner,
            "target": self.context.target,
            "input": self.context.input,
            "expectedRevision": self.context.expected_revision,
            "payloadHash": self.payload_hash,
        });
        use sha2::{Digest, Sha256};
        Sha256::digest(canonical_json(&value).as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

impl From<CronReadFailure> for CronListOutcome {
    fn from(value: CronReadFailure) -> Self {
        match value {
            CronReadFailure::Unavailable => Self::Unavailable,
            CronReadFailure::Rejected => Self::Rejected,
            CronReadFailure::Protocol => Self::Protocol,
        }
    }
}

impl From<CronMutationOutcome<CronJob>> for CronJobMutationOutcome {
    fn from(value: CronMutationOutcome<CronJob>) -> Self {
        match value {
            CronMutationOutcome::Applied(job) => Self::Applied(Box::new(job)),
            CronMutationOutcome::Rejected => Self::Rejected,
            CronMutationOutcome::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

impl From<CronMutationOutcome<CronRemoved>> for CronDeleteOutcome {
    fn from(value: CronMutationOutcome<CronRemoved>) -> Self {
        match value {
            CronMutationOutcome::Applied(receipt) => Self::Applied(receipt),
            CronMutationOutcome::Rejected => Self::Rejected,
            CronMutationOutcome::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
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
        let command = CronCreateCommand::try_new(
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
        .unwrap();
        assert!(command.into_gateway().is_ok());

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
    fn projects_structured_schedules_to_gateway_commands() {
        let at_command = CronCreateCommand::try_new(
            "Cron name".into(),
            "main".into(),
            "Scheduled message".into(),
            None,
            CronScheduleCommand::At {
                at: "2026-09-04T09:00:00.000Z".into(),
            },
            CronDeliveryCommand::None,
            true,
        )
        .unwrap();
        let at_gateway = serde_json::to_value(at_command.into_gateway().unwrap()).unwrap();
        assert_eq!(
            at_gateway["schedule"],
            serde_json::json!({ "kind": "at", "at": "2026-09-04T09:00:00.000Z" })
        );

        let every_command = CronUpdateCommand::try_new(
            "cron-job".into(),
            None,
            None,
            None,
            None,
            Some(CronScheduleCommand::Every {
                every_ms: 60_000,
                anchor_ms: Some(1_000),
            }),
            None,
            None,
        )
        .unwrap();
        let (_job_id, patch) = every_command.into_gateway().unwrap();
        let every_gateway = serde_json::to_value(patch).unwrap();
        assert_eq!(
            every_gateway["schedule"],
            serde_json::json!({ "kind": "every", "everyMs": 60_000, "anchorMs": 1_000 })
        );

        let cron_command = CronUpdateCommand::try_new(
            "cron-job".into(),
            None,
            None,
            None,
            None,
            Some(CronScheduleCommand::Cron {
                expr: "0 9 * * *".into(),
                tz: Some("UTC".into()),
            }),
            None,
            None,
        )
        .unwrap();
        let (_job_id, patch) = cron_command.into_gateway().unwrap();
        let cron_gateway = serde_json::to_value(patch).unwrap();
        assert_eq!(
            cron_gateway["schedule"],
            serde_json::json!({ "kind": "cron", "expr": "0 9 * * *", "tz": "UTC" })
        );
    }

    #[test]
    fn update_rejects_empty_or_malformed_commands() {
        assert!(
            CronUpdateCommand::try_new("cron-job".into(), None, None, None, None, None, None, None,)
                .is_err()
        );
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
            CronJobMutationOutcome::from(CronMutationOutcome::OutcomeUnknown),
            CronJobMutationOutcome::OutcomeUnknown
        ));
        assert!(matches!(
            CronDeleteOutcome::from(CronMutationOutcome::OutcomeUnknown),
            CronDeleteOutcome::OutcomeUnknown
        ));
    }
}
