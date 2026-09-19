use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::{
    cron::{
        CronCreateCommand, CronDeleteCommand, CronDeleteOutcome, CronDeliveryCommand,
        CronHistoryCommand, CronHistoryOutcome, CronJobMutationOutcome, CronListOutcome,
        CronScheduleCommand, CronUpdateCommand,
    },
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod handler;

pub(crate) const LIST_PATH: &str = "/api/cron/jobs";
pub(crate) const CREATE_PATH: &str = "/api/cron/jobs/create";
pub(crate) const UPDATE_PATH: &str = "/api/cron/jobs/update";
pub(crate) const DELETE_PATH: &str = "/api/cron/jobs/delete";
pub(crate) const TOGGLE_PATH: &str = "/api/cron/jobs/toggle";
pub(crate) const TRIGGER_PATH: &str = "/api/cron/jobs/trigger";
pub(crate) const SESSION_HISTORY_PATH: &str = "/api/cron/session-history";
pub(crate) const MAX_HISTORY_LIMIT: u64 = 200;
pub(crate) const DEFAULT_HISTORY_LIMIT: u64 = MAX_HISTORY_LIMIT;
const MAX_SESSION_KEY_BYTES: usize = 4 * 1024;
const CAPABILITY_ID: &str = "scheduler.cron";
const SCOPE: &str = "cron:write";
const SUBJECT: &str = "cron-crud";
const HISTORY_CAPABILITY_ID: &str = "scheduler.cron.history";
const HISTORY_SCOPE: &str = "cron:history:read";
const HISTORY_SUBJECT: &str = "cron-session-history";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    id: String,
    operation_id: String,
    scope: ScopeRequest,
    target: CreateTarget,
    input: CreateInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateRequest {
    id: String,
    operation_id: String,
    scope: ScopeRequest,
    target: JobTarget,
    input: UpdateInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteRequest {
    id: String,
    operation_id: String,
    scope: ScopeRequest,
    target: JobTarget,
    input: DeleteInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToggleRequest {
    id: String,
    operation_id: String,
    scope: ScopeRequest,
    target: JobTarget,
    input: ToggleInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriggerRequest {
    id: String,
    operation_id: String,
    scope: ScopeRequest,
    target: JobTarget,
    input: TriggerInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopeRequest {
    kind: String,
    endpoint: Endpoint,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateTarget {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobTarget {
    kind: String,
    job_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    name: String,
    agent_id: String,
    message: String,
    model: Option<String>,
    schedule: ScheduleInput,
    delivery: DeliveryInput,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateInput {
    job_id: String,
    name: Option<String>,
    agent_id: Option<String>,
    message: Option<String>,
    #[serde(default, deserialize_with = "deserialize_model_patch")]
    model: Option<Option<String>>,
    schedule: Option<ScheduleInput>,
    delivery: Option<DeliveryInput>,
    enabled: Option<bool>,
}

fn deserialize_model_patch<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Missing uses serde's default; a present null must remain an explicit clear.
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteInput {
    job_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToggleInput {
    id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriggerInput {
    id: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ScheduleInput {
    CronExpression(String),
    Schedule(ScheduleObjectInput),
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ScheduleObjectInput {
    Cron {
        expr: String,
        tz: Option<String>,
    },
    At {
        at: String,
    },
    Every {
        #[serde(rename = "everyMs")]
        every_ms: u64,
        #[serde(rename = "anchorMs")]
        anchor_ms: Option<u64>,
    },
}

impl ScheduleInput {
    fn into_command(self) -> CronScheduleCommand {
        match self {
            Self::CronExpression(expr) => CronScheduleCommand::cron(expr),
            Self::Schedule(ScheduleObjectInput::Cron { expr, tz }) => {
                CronScheduleCommand::Cron { expr, tz }
            }
            Self::Schedule(ScheduleObjectInput::At { at }) => CronScheduleCommand::At { at },
            Self::Schedule(ScheduleObjectInput::Every {
                every_ms,
                anchor_ms,
            }) => CronScheduleCommand::Every {
                every_ms,
                anchor_ms,
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
enum DeliveryInput {
    None {},
    Announce {
        channel: String,
        to: String,
        account_id: String,
    },
}

impl DeliveryInput {
    fn into_command(self) -> CronDeliveryCommand {
        match self {
            Self::None {} => CronDeliveryCommand::None,
            Self::Announce {
                channel,
                to,
                account_id,
            } => CronDeliveryCommand::Announce {
                channel,
                to,
                account_id,
            },
        }
    }
}

impl Endpoint {
    fn is_openclaw_local(&self) -> bool {
        self.kind == "native-runtime"
            && self.runtime_adapter_id == "openclaw"
            && self.runtime_instance_id == "local"
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CronHistoryQuery {
    pub(crate) session_key: String,
    pub(crate) limit: u64,
}

impl CronHistoryQuery {
    pub(crate) fn into_command(self) -> Result<CronHistoryCommand, DecodeError> {
        CronHistoryCommand::try_new(self.session_key, self.limit).map_err(|_| DecodeError::Invalid)
    }

    pub(crate) fn decode(
        query: Option<&str>,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        verifier
            .verify(
                authorization,
                now,
                SESSION_HISTORY_PATH,
                HISTORY_SCOPE,
                HISTORY_CAPABILITY_ID,
                HISTORY_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;

        let query = query.ok_or(DecodeError::Invalid)?;
        let mut session_key = None;
        let mut limit = None;
        if query.is_empty() {
            return Err(DecodeError::Invalid);
        }
        for pair in query.split('&') {
            let Some((raw_name, raw_value)) = pair.split_once('=') else {
                return Err(DecodeError::Invalid);
            };
            let name = percent_decode_query_component(raw_name).ok_or(DecodeError::Invalid)?;
            let value = percent_decode_query_component(raw_value).ok_or(DecodeError::Invalid)?;
            match name.as_str() {
                "sessionKey" if session_key.is_none() => session_key = Some(value),
                "limit" if limit.is_none() => limit = Some(value),
                _ => return Err(DecodeError::Invalid),
            }
        }

        let session_key = session_key
            .filter(|value| {
                !value.trim().is_empty()
                    && value.len() <= MAX_SESSION_KEY_BYTES
                    && !value.contains('\0')
                    && !value.chars().any(char::is_control)
            })
            .ok_or(DecodeError::Invalid)?;
        let limit = match limit {
            None => DEFAULT_HISTORY_LIMIT,
            Some(value) => value
                .parse::<u64>()
                .ok()
                .filter(|value| (1..=MAX_HISTORY_LIMIT).contains(value))
                .ok_or(DecodeError::Invalid)?,
        };
        Ok(Self { session_key, limit })
    }
}

fn percent_decode_query_component(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        match byte {
            b'+' => bytes.push(b' '),
            b'%' => {
                let high = hex_value(input.next()?)?;
                let low = hex_value(input.next()?)?;
                bytes.push(high << 4 | low);
            }
            byte => bytes.push(byte),
        }
    }
    String::from_utf8(bytes).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub(crate) enum CronRequest {
    List,
    Create(CronCreateCommand),
    Update(CronUpdateCommand),
    Delete(CronDeleteCommand),
    Trigger(String),
}

impl CronRequest {
    pub(crate) fn decode(
        path: &str,
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        if !matches!(
            path,
            LIST_PATH | CREATE_PATH | UPDATE_PATH | DELETE_PATH | TOGGLE_PATH | TRIGGER_PATH
        ) {
            return Err(DecodeError::Invalid);
        }
        verifier
            .verify(authorization, now, path, SCOPE, CAPABILITY_ID, SUBJECT)
            .map_err(|_| DecodeError::Unauthorized)?;
        match path {
            LIST_PATH => {
                if value != serde_json::json!({}) {
                    return Err(DecodeError::Invalid);
                }
                Ok(Self::List)
            }
            CREATE_PATH => decode_create(value),
            UPDATE_PATH => decode_update(value),
            DELETE_PATH => decode_delete(value),
            TOGGLE_PATH => decode_toggle(value),
            TRIGGER_PATH => decode_trigger(value),
            _ => Err(DecodeError::Invalid),
        }
    }
}

fn decode_create(value: Value) -> Result<CronRequest, DecodeError> {
    reject_null_schedule_fields(&value)?;
    let request =
        serde_json::from_value::<CreateRequest>(value).map_err(|_| DecodeError::Invalid)?;
    if request.id != CAPABILITY_ID
        || request.operation_id != "cron.create"
        || request.scope.kind != "runtime-instance"
        || !request.scope.endpoint.is_openclaw_local()
        || request.target.kind != "cron-job"
    {
        return Err(DecodeError::Invalid);
    }
    CronCreateCommand::try_new(
        request.input.name,
        request.input.agent_id,
        request.input.message,
        request.input.model,
        request.input.schedule.into_command(),
        request.input.delivery.into_command(),
        request.input.enabled,
    )
    .map(CronRequest::Create)
    .map_err(|_| DecodeError::Invalid)
}

fn decode_update(value: Value) -> Result<CronRequest, DecodeError> {
    reject_null_schedule_fields(&value)?;
    let request =
        serde_json::from_value::<UpdateRequest>(value).map_err(|_| DecodeError::Invalid)?;
    if request.id != CAPABILITY_ID
        || request.operation_id != "cron.update"
        || request.scope.kind != "runtime-instance"
        || !request.scope.endpoint.is_openclaw_local()
        || request.target.kind != "cron-job"
        || request.target.job_id != request.input.job_id
    {
        return Err(DecodeError::Invalid);
    }
    CronUpdateCommand::try_new(
        request.input.job_id,
        request.input.name,
        request.input.agent_id,
        request.input.message,
        request.input.model,
        request.input.schedule.map(ScheduleInput::into_command),
        request.input.delivery.map(DeliveryInput::into_command),
        request.input.enabled,
    )
    .map(CronRequest::Update)
    .map_err(|_| DecodeError::Invalid)
}

fn reject_null_schedule_fields(value: &Value) -> Result<(), DecodeError> {
    let Some(schedule) = value.pointer("/input/schedule") else {
        return Ok(());
    };
    if schedule.is_null()
        || schedule.pointer("/tz").is_some_and(Value::is_null)
        || schedule.pointer("/anchorMs").is_some_and(Value::is_null)
    {
        return Err(DecodeError::Invalid);
    }
    Ok(())
}

fn decode_delete(value: Value) -> Result<CronRequest, DecodeError> {
    let request =
        serde_json::from_value::<DeleteRequest>(value).map_err(|_| DecodeError::Invalid)?;
    if request.id != CAPABILITY_ID
        || request.operation_id != "cron.delete"
        || request.scope.kind != "runtime-instance"
        || !request.scope.endpoint.is_openclaw_local()
        || request.target.kind != "cron-job"
        || request.target.job_id != request.input.job_id
    {
        return Err(DecodeError::Invalid);
    }
    CronDeleteCommand::try_new(request.input.job_id)
        .map(CronRequest::Delete)
        .map_err(|_| DecodeError::Invalid)
}

fn decode_toggle(value: Value) -> Result<CronRequest, DecodeError> {
    let request =
        serde_json::from_value::<ToggleRequest>(value).map_err(|_| DecodeError::Invalid)?;
    if request.id != CAPABILITY_ID
        || request.operation_id != "cron.toggle"
        || request.scope.kind != "runtime-instance"
        || !request.scope.endpoint.is_openclaw_local()
        || request.target.kind != "cron-job"
        || request.target.job_id != request.input.id
    {
        return Err(DecodeError::Invalid);
    }
    CronUpdateCommand::try_new(
        request.input.id,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(request.input.enabled),
    )
    .map(CronRequest::Update)
    .map_err(|_| DecodeError::Invalid)
}

fn decode_trigger(value: Value) -> Result<CronRequest, DecodeError> {
    let request =
        serde_json::from_value::<TriggerRequest>(value).map_err(|_| DecodeError::Invalid)?;
    if request.id != CAPABILITY_ID
        || request.operation_id != "cron.trigger"
        || request.scope.kind != "runtime-instance"
        || !request.scope.endpoint.is_openclaw_local()
        || request.target.kind != "cron-job"
        || request.target.job_id != request.input.id
        || request.input.id.trim().is_empty()
    {
        return Err(DecodeError::Invalid);
    }
    Ok(CronRequest::Trigger(request.input.id))
}

pub(crate) struct JobResponse {
    id: String,
    name: String,
    agent_id: String,
    message: String,
    model: Option<String>,
    schedule: ScheduleResponse,
    delivery: DeliveryResponse,
    target: Option<TargetResponse>,
    enabled: bool,
    created_at: String,
    updated_at: String,
    last_run: Option<LastRunResponse>,
    next_run: Option<String>,
    running_at: Option<String>,
}

enum ScheduleResponse {
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

enum DeliveryResponse {
    None,
    Announce {
        channel: String,
        to: Option<String>,
        account_id: Option<String>,
    },
}

struct TargetResponse {
    channel_type: String,
    channel_id: String,
    channel_name: String,
    recipient: Option<String>,
}

struct LastRunResponse {
    time: String,
    success: bool,
    error: Option<String>,
    duration: Option<u64>,
}

impl TryFrom<crate::cron::CronJobView> for JobResponse {
    type Error = &'static str;

    fn try_from(job: crate::cron::CronJobView) -> Result<Self, Self::Error> {
        let agent_id = job
            .agent_id
            .filter(|value| is_non_empty_legacy_text(value))
            .ok_or("agentId.missing")?;
        let message = job
            .message
            .filter(|value| is_non_empty_legacy_text(value))
            .ok_or("message.missing")?;
        let state = job.state;
        let last_run = state
            .last_run_at_ms
            .filter(|time| *time > 0)
            .map(|time| -> Result<LastRunResponse, &'static str> {
                Ok(LastRunResponse {
                    time: iso_timestamp(time).map_err(|_| "lastRun.time.invalid")?,
                    success: matches!(
                        state.last_run_status,
                        Some(crate::cron::CronRunStatusView::Ok)
                    ),
                    error: state.last_error.clone(),
                    duration: state.last_duration_ms,
                })
            })
            .transpose()?;
        let next_run = state
            .next_run_at_ms
            .filter(|time| *time > 0)
            .map(|time| iso_timestamp(time).map_err(|_| "nextRun.invalid"))
            .transpose()?;
        let running_at = state
            .running_at_ms
            .filter(|time| *time > 0)
            .map(|time| iso_timestamp(time).map_err(|_| "runningAt.invalid"))
            .transpose()?;
        let (delivery, target) = match job.delivery {
            crate::cron::CronDeliveryView::None => (DeliveryResponse::None, None),
            crate::cron::CronDeliveryView::Announce {
                channel,
                to,
                account_id,
            } => {
                let target = TargetResponse {
                    channel_type: channel.clone(),
                    channel_id: account_id.clone(),
                    channel_name: channel.clone(),
                    recipient: Some(to.clone()),
                };
                (
                    DeliveryResponse::Announce {
                        channel,
                        to: Some(to),
                        account_id: Some(account_id),
                    },
                    Some(target),
                )
            }
        };
        Ok(Self {
            id: job.id,
            name: job.name,
            agent_id,
            message,
            model: job.model,
            schedule: match job.schedule {
                crate::cron::CronScheduleView::At { at } => ScheduleResponse::At { at },
                crate::cron::CronScheduleView::Every {
                    every_ms,
                    anchor_ms,
                } => ScheduleResponse::Every {
                    every_ms,
                    anchor_ms,
                },
                crate::cron::CronScheduleView::Cron { expr, tz } => {
                    ScheduleResponse::Cron { expr, tz }
                }
            },
            delivery,
            target,
            enabled: job.enabled,
            created_at: iso_timestamp(job.created_at_ms).map_err(|_| "createdAt.invalid")?,
            updated_at: iso_timestamp(job.updated_at_ms).map_err(|_| "updatedAt.invalid")?,
            last_run,
            next_run,
            running_at,
        })
    }
}

fn project_job_response(job: JobResponse) -> Value {
    let mut value = Map::new();
    value.insert("id".to_owned(), Value::String(job.id));
    value.insert("name".to_owned(), Value::String(job.name));
    value.insert("agentId".to_owned(), Value::String(job.agent_id));
    value.insert("message".to_owned(), Value::String(job.message));
    if let Some(model) = job.model {
        value.insert("model".to_owned(), Value::String(model));
    }
    value.insert(
        "schedule".to_owned(),
        project_schedule_response(job.schedule),
    );
    value.insert(
        "delivery".to_owned(),
        project_delivery_response(job.delivery),
    );
    if let Some(target) = job.target {
        value.insert("target".to_owned(), project_target_response(target));
    }
    value.insert("enabled".to_owned(), Value::Bool(job.enabled));
    value.insert("createdAt".to_owned(), Value::String(job.created_at));
    value.insert("updatedAt".to_owned(), Value::String(job.updated_at));
    if let Some(last_run) = job.last_run {
        value.insert("lastRun".to_owned(), project_last_run_response(last_run));
    }
    if let Some(next_run) = job.next_run {
        value.insert("nextRun".to_owned(), Value::String(next_run));
    }
    if let Some(running_at) = job.running_at {
        value.insert("runningAt".to_owned(), Value::String(running_at));
    }
    Value::Object(value)
}

fn project_schedule_response(schedule: ScheduleResponse) -> Value {
    match schedule {
        ScheduleResponse::At { at } => serde_json::json!({ "kind": "at", "at": at }),
        ScheduleResponse::Every {
            every_ms,
            anchor_ms,
        } => {
            let mut value = Map::new();
            value.insert("kind".to_owned(), Value::String("every".to_owned()));
            value.insert("everyMs".to_owned(), Value::from(every_ms));
            if let Some(anchor_ms) = anchor_ms {
                value.insert("anchorMs".to_owned(), Value::from(anchor_ms));
            }
            Value::Object(value)
        }
        ScheduleResponse::Cron { expr, tz } => {
            let mut value = Map::new();
            value.insert("kind".to_owned(), Value::String("cron".to_owned()));
            value.insert("expr".to_owned(), Value::String(expr));
            if let Some(tz) = tz {
                value.insert("tz".to_owned(), Value::String(tz));
            }
            Value::Object(value)
        }
    }
}

fn project_delivery_response(delivery: DeliveryResponse) -> Value {
    match delivery {
        DeliveryResponse::None => serde_json::json!({ "mode": "none" }),
        DeliveryResponse::Announce {
            channel,
            to,
            account_id,
        } => {
            let mut value = Map::new();
            value.insert("mode".to_owned(), Value::String("announce".to_owned()));
            value.insert("channel".to_owned(), Value::String(channel));
            if let Some(to) = to {
                value.insert("to".to_owned(), Value::String(to));
            }
            if let Some(account_id) = account_id {
                value.insert("accountId".to_owned(), Value::String(account_id));
            }
            Value::Object(value)
        }
    }
}

fn project_target_response(target: TargetResponse) -> Value {
    let mut value = Map::new();
    value.insert("channelType".to_owned(), Value::String(target.channel_type));
    value.insert("channelId".to_owned(), Value::String(target.channel_id));
    value.insert("channelName".to_owned(), Value::String(target.channel_name));
    if let Some(recipient) = target.recipient {
        value.insert("recipient".to_owned(), Value::String(recipient));
    }
    Value::Object(value)
}

fn project_last_run_response(last_run: LastRunResponse) -> Value {
    let mut value = Map::new();
    value.insert("time".to_owned(), Value::String(last_run.time));
    value.insert("success".to_owned(), Value::Bool(last_run.success));
    if let Some(error) = last_run.error {
        value.insert("error".to_owned(), Value::String(error));
    }
    if let Some(duration) = last_run.duration {
        value.insert("duration".to_owned(), Value::from(duration));
    }
    Value::Object(value)
}

fn iso_timestamp(milliseconds: u64) -> Result<String, ()> {
    let milliseconds = i64::try_from(milliseconds).map_err(|_| ())?;
    chrono::DateTime::from_timestamp_millis(milliseconds)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(crate) fn list_body(outcome: CronListOutcome) -> (u16, Value) {
    match outcome {
        CronListOutcome::Listed(jobs) => {
            let jobs = jobs
                .jobs
                .into_iter()
                .filter_map(project_legacy_renderer_job)
                .collect::<Vec<_>>();
            (
                200,
                serde_json::json!({
                    "success": true,
                    "ready": true,
                    "refreshing": false,
                    "updatedAt": now_millis(),
                    "error": null,
                    "jobs": jobs,
                }),
            )
        }
        CronListOutcome::Unavailable => unavailable(),
        CronListOutcome::Rejected => fixed(422, "Cron list was rejected"),
        CronListOutcome::Protocol => fixed(502, "Cron list response is invalid"),
    }
}

pub(crate) fn history_body(outcome: CronHistoryOutcome) -> (u16, Value) {
    match outcome {
        CronHistoryOutcome::Loaded(history) => (200, project_history(history)),
        CronHistoryOutcome::Rejected => fixed(422, "Cron history was rejected"),
        CronHistoryOutcome::Protocol => fixed(502, "Cron history response is invalid"),
        CronHistoryOutcome::Unavailable => unavailable(),
        CronHistoryOutcome::Deadline => fixed(504, "Cron service deadline exceeded"),
    }
}

fn project_history(history: crate::cron::CronHistoryView) -> Value {
    serde_json::json!({
        "messages": history.messages.into_iter().map(project_history_message).collect::<Vec<_>>()
    })
}

fn project_history_message(message: crate::cron::CronHistoryMessageView) -> Value {
    serde_json::json!({
        "role": match message.role {
            crate::cron::CronHistoryRole::User => "user",
            crate::cron::CronHistoryRole::Assistant => "assistant",
        },
        "text": message.text,
    })
}

pub(crate) fn job_body(outcome: CronJobMutationOutcome) -> (u16, Value) {
    match outcome {
        CronJobMutationOutcome::Applied(job) => match JobResponse::try_from(*job) {
            Ok(job) => (200, project_job_response(job)),
            Err(_) => fixed(409, "Cron operation outcome is unknown"),
        },
        CronJobMutationOutcome::Rejected => fixed(422, "Cron operation was rejected"),
        CronJobMutationOutcome::OutcomeUnknown => fixed(409, "Cron operation outcome is unknown"),
        CronJobMutationOutcome::Unavailable => unavailable(),
    }
}

pub(crate) fn delete_body(outcome: CronDeleteOutcome) -> (u16, Value) {
    match outcome {
        CronDeleteOutcome::Applied(receipt) => {
            (200, serde_json::json!({ "removed": receipt.removed }))
        }
        CronDeleteOutcome::Rejected => fixed(422, "Cron operation was rejected"),
        CronDeleteOutcome::OutcomeUnknown => fixed(409, "Cron operation outcome is unknown"),
        CronDeleteOutcome::Unavailable => unavailable(),
    }
}

pub(crate) fn trigger_body(
    outcome: Result<crate::cron::CronTriggerResult, crate::RequestAdmissionClosed>,
) -> (u16, Value) {
    match outcome {
        Ok(crate::cron::CronTriggerResult::Accepted) => (
            200,
            serde_json::json!({ "success": true, "result": { "outcome": "accepted" } }),
        ),
        Ok(crate::cron::CronTriggerResult::Skipped(disposition)) => {
            let reason = match disposition {
                crate::cron::CronTriggerSkipReason::AlreadyRunning => "already-running",
                crate::cron::CronTriggerSkipReason::NotDue => "not-due",
                crate::cron::CronTriggerSkipReason::InvalidSpec => "invalid-spec",
                crate::cron::CronTriggerSkipReason::Disabled => "disabled",
                crate::cron::CronTriggerSkipReason::Stopped => "stopped",
            };
            (
                200,
                serde_json::json!({ "success": true, "result": { "outcome": "skipped", "reason": reason } }),
            )
        }
        Ok(crate::cron::CronTriggerResult::OutcomeUnknown) => {
            fixed(409, "Cron operation outcome is unknown")
        }
        Err(_) => unavailable(),
    }
}

fn project_legacy_renderer_job(job: crate::cron::CronJobView) -> Option<Value> {
    JobResponse::try_from(job).ok().map(project_job_response)
}

fn is_non_empty_legacy_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0')
}

fn unavailable() -> (u16, Value) {
    fixed(503, "Cron service is unavailable")
}

fn fixed(status: u16, error: &'static str) -> (u16, Value) {
    (
        status,
        serde_json::json!({ "success": false, "error": error }),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn job() -> crate::cron::CronJobView {
        crate::cron::CronJobView {
            id: "job-1".into(),
            name: "Morning reminder".into(),
            agent_id: Some("main".into()),
            message: Some("Review the dashboard.".into()),
            model: Some("model-primary".into()),
            schedule: crate::cron::CronScheduleView::Cron {
                expr: "0 9 * * *".into(),
                tz: Some("UTC".into()),
            },
            delivery: crate::cron::CronDeliveryView::Announce {
                channel: "telegram".into(),
                to: "recipient".into(),
                account_id: "account".into(),
            },
            enabled: true,
            created_at_ms: 1,
            updated_at_ms: 2,
            state: crate::cron::CronJobStateView {
                next_run_at_ms: Some(3),
                running_at_ms: Some(4),
                last_run_at_ms: Some(5),
                last_run_status: Some(crate::cron::CronRunStatusView::Error),
                last_error: Some("Cron command failed".into()),
                last_duration_ms: Some(6),
            },
        }
    }

    fn jobs() -> crate::cron::CronListView {
        let mut ui_no_delivery_job = job();
        ui_no_delivery_job.id = "job-no-delivery".into();
        ui_no_delivery_job.delivery = crate::cron::CronDeliveryView::None;
        let mut native_system_job = job();
        native_system_job.id = "job-system".into();
        native_system_job.agent_id = None;
        native_system_job.message = None;

        crate::cron::CronListView {
            jobs: vec![job(), ui_no_delivery_job, native_system_job],
        }
    }

    fn create_request() -> Value {
        json!({
            "id": "scheduler.cron",
            "operationId": "cron.create",
            "scope": {
                "kind": "runtime-instance",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
            },
            "target": { "kind": "cron-job" },
            "input": {
                "name": "Daily report",
                "agentId": "main",
                "message": "Summarize today",
                "schedule": "0 9 * * *",
                "delivery": { "mode": "none" },
                "enabled": true,
            },
        })
    }

    #[test]
    fn unit_variant_rejects_unknown_fields() {
        assert!(matches!(
            decode_create(create_request()),
            Ok(CronRequest::Create(_))
        ));

        let mut unknown_delivery_field = create_request();
        unknown_delivery_field["input"]["delivery"]["bogus"] = json!(1);
        assert!(matches!(
            decode_create(unknown_delivery_field),
            Err(DecodeError::Invalid)
        ));
    }

    #[test]
    fn accepts_only_the_closed_create_shape() {
        assert!(matches!(
            decode_create(create_request()),
            Ok(CronRequest::Create(_))
        ));

        let mut unknown_field = create_request();
        unknown_field["input"]["unexpected"] = json!(true);
        assert!(matches!(
            decode_create(unknown_field),
            Err(DecodeError::Invalid)
        ));

        let mut wrong_endpoint = create_request();
        wrong_endpoint["scope"]["endpoint"]["runtimeAdapterId"] = json!("other");
        assert!(matches!(
            decode_create(wrong_endpoint),
            Err(DecodeError::Invalid)
        ));
    }

    #[test]
    fn accepts_structured_create_and_update_schedules() {
        let mut at_create = create_request();
        at_create["input"]["schedule"] = json!({ "kind": "at", "at": "2026-09-04T09:00:00.000Z" });
        assert!(matches!(
            decode_create(at_create),
            Ok(CronRequest::Create(_))
        ));

        let update = json!({
            "id": "scheduler.cron",
            "operationId": "cron.update",
            "scope": {
                "kind": "runtime-instance",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
            },
            "target": { "kind": "cron-job", "jobId": "job-a" },
            "input": {
                "jobId": "job-a",
                "schedule": { "kind": "every", "everyMs": 60_000, "anchorMs": 1_000 },
            },
        });
        assert!(matches!(decode_update(update), Ok(CronRequest::Update(_))));

        let mut invalid = create_request();
        invalid["input"]["schedule"] = json!({ "kind": "stream", "command": ["tail"] });
        assert!(matches!(decode_create(invalid), Err(DecodeError::Invalid)));
    }

    #[test]
    fn binds_job_mutation_targets_to_their_inputs() {
        let update = json!({
            "id": "scheduler.cron",
            "operationId": "cron.update",
            "scope": {
                "kind": "runtime-instance",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
            },
            "target": { "kind": "cron-job", "jobId": "job-a" },
            "input": { "jobId": "job-b", "name": "Updated" },
        });
        assert!(matches!(decode_update(update), Err(DecodeError::Invalid)));

        let delete = json!({
            "id": "scheduler.cron",
            "operationId": "cron.delete",
            "scope": {
                "kind": "runtime-instance",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
            },
            "target": { "kind": "cron-job", "jobId": "job-a" },
            "input": { "jobId": "job-b" },
        });
        assert!(matches!(decode_delete(delete), Err(DecodeError::Invalid)));

        let toggle = json!({
            "id": "scheduler.cron",
            "operationId": "cron.toggle",
            "scope": {
                "kind": "runtime-instance",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
            },
            "target": { "kind": "cron-job", "jobId": "job-a" },
            "input": { "id": "job-b", "enabled": false },
        });
        assert!(matches!(decode_toggle(toggle), Err(DecodeError::Invalid)));

        let trigger = json!({
            "id": "scheduler.cron",
            "operationId": "cron.trigger",
            "scope": {
                "kind": "runtime-instance",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
            },
            "target": { "kind": "cron-job", "jobId": "job-a" },
            "input": { "id": "job-b" },
        });
        assert!(matches!(decode_trigger(trigger), Err(DecodeError::Invalid)));
    }

    #[test]
    fn projects_the_legacy_renderer_job_dto_in_rust() {
        let response = project_job_response(JobResponse::try_from(job()).unwrap());

        assert_eq!(
            response,
            json!({
                "id": "job-1",
                "name": "Morning reminder",
                "agentId": "main",
                "message": "Review the dashboard.",
                "model": "model-primary",
                "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "UTC" },
                "delivery": {
                    "mode": "announce",
                    "channel": "telegram",
                    "to": "recipient",
                    "accountId": "account",
                },
                "target": {
                    "channelType": "telegram",
                    "channelId": "account",
                    "channelName": "telegram",
                    "recipient": "recipient",
                },
                "enabled": true,
                "createdAt": "1970-01-01T00:00:00.001Z",
                "updatedAt": "1970-01-01T00:00:00.002Z",
                "lastRun": {
                    "time": "1970-01-01T00:00:00.005Z",
                    "success": false,
                    "error": "Cron command failed",
                    "duration": 6,
                },
                "nextRun": "1970-01-01T00:00:00.003Z",
                "runningAt": "1970-01-01T00:00:00.004Z",
            })
        );
    }

    #[test]
    fn list_projection_returns_the_legacy_snapshot_and_skips_non_ui_jobs() {
        let (status, snapshot) = list_body(CronListOutcome::Listed(jobs()));

        assert_eq!(status, 200);
        let snapshot_keys = snapshot.as_object().unwrap();
        assert_eq!(snapshot_keys.len(), 6);
        for key in [
            "success",
            "ready",
            "refreshing",
            "updatedAt",
            "error",
            "jobs",
        ] {
            assert!(snapshot_keys.contains_key(key));
        }
        assert_eq!(snapshot["success"], true);
        assert_eq!(snapshot["ready"], true);
        assert_eq!(snapshot["refreshing"], false);
        assert!(snapshot["updatedAt"].as_u64().is_some());
        assert_eq!(snapshot["error"], serde_json::Value::Null);
        assert_eq!(snapshot["jobs"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["jobs"][0]["createdAt"], "1970-01-01T00:00:00.001Z");
        assert_eq!(snapshot["jobs"][1]["id"], "job-no-delivery");
        assert_eq!(snapshot["jobs"][1]["delivery"], json!({ "mode": "none" }));
        assert!(snapshot["jobs"][1].get("target").is_none());
        assert!(snapshot.get("deliveryPreviews").is_none());
        assert!(snapshot.get("snapshotRevision").is_none());
        assert!(snapshot.get("configRevision").is_none());
        assert!(snapshot["jobs"][0].get("createdAtMs").is_none());
        assert!(snapshot["jobs"][0].get("sessionKey").is_none());
        assert!(snapshot["jobs"][0].get("description").is_none());
        assert!(snapshot["jobs"][0].get("deleteAfterRun").is_none());
        assert!(snapshot["jobs"][0]["schedule"].get("staggerMs").is_none());
        assert!(snapshot["jobs"][0]["delivery"].get("threadId").is_none());
        assert!(snapshot["jobs"][0]["delivery"].get("bestEffort").is_none());
        assert!(
            snapshot["jobs"][0]["delivery"]
                .get("failureDestination")
                .is_none()
        );
        assert!(snapshot["jobs"][0].get("payload").is_none());
        assert!(snapshot["jobs"][0].get("failureAlert").is_none());
        assert!(snapshot["jobs"][0].get("state").is_none());

        let mut native_without_agent = job();
        native_without_agent.id = "job-native-command".into();
        native_without_agent.agent_id = None;
        native_without_agent.message = None;
        native_without_agent.delivery = crate::cron::CronDeliveryView::None;
        let (status, snapshot) = list_body(CronListOutcome::Listed(crate::cron::CronListView {
            jobs: vec![native_without_agent],
        }));
        assert_eq!(status, 200);
        assert!(snapshot["jobs"].as_array().unwrap().is_empty());
    }

    #[test]
    fn applied_mutation_with_an_unprojectable_job_is_outcome_unknown() {
        let mut invalid = job();
        invalid.message = None;

        assert_eq!(
            job_body(CronJobMutationOutcome::Applied(Box::new(invalid))),
            fixed(409, "Cron operation outcome is unknown")
        );
    }

    #[test]
    fn projects_trigger_results_for_descriptor_execute_transport() {
        assert_eq!(
            trigger_body(Ok(crate::cron::CronTriggerResult::Accepted)),
            (
                200,
                json!({ "success": true, "result": { "outcome": "accepted" } })
            )
        );
        for (disposition, reason) in [
            (
                crate::cron::CronTriggerSkipReason::AlreadyRunning,
                "already-running",
            ),
            (crate::cron::CronTriggerSkipReason::NotDue, "not-due"),
            (
                crate::cron::CronTriggerSkipReason::InvalidSpec,
                "invalid-spec",
            ),
            (crate::cron::CronTriggerSkipReason::Disabled, "disabled"),
            (crate::cron::CronTriggerSkipReason::Stopped, "stopped"),
        ] {
            assert_eq!(
                trigger_body(Ok(crate::cron::CronTriggerResult::Skipped(disposition))),
                (
                    200,
                    json!({ "success": true, "result": { "outcome": "skipped", "reason": reason } })
                )
            );
        }
        assert_eq!(
            trigger_body(Ok(crate::cron::CronTriggerResult::OutcomeUnknown)),
            fixed(409, "Cron operation outcome is unknown")
        );
    }

    #[test]
    fn mutation_outcome_mapping_preserves_unknown_delivery() {
        assert_eq!(
            job_body(CronJobMutationOutcome::OutcomeUnknown),
            fixed(409, "Cron operation outcome is unknown")
        );
        assert_eq!(
            job_body(CronJobMutationOutcome::Rejected),
            fixed(422, "Cron operation was rejected")
        );
        assert_eq!(
            delete_body(CronDeleteOutcome::OutcomeUnknown),
            fixed(409, "Cron operation outcome is unknown")
        );
        assert_eq!(
            list_body(CronListOutcome::Protocol),
            fixed(502, "Cron list response is invalid")
        );
        assert_eq!(list_body(CronListOutcome::Unavailable), unavailable());
    }

    #[test]
    fn cron_history_query_requires_the_exact_public_shape() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        let query = CronHistoryQuery::decode(
            Some("sessionKey=agent%3Amain%3Acron%3Ajob-1&limit=12"),
            &decision("history:one"),
            &mut verifier,
            1,
        )
        .unwrap();
        assert_eq!(query.session_key, "agent:main:cron:job-1");
        assert_eq!(query.limit, 12);

        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        let query = CronHistoryQuery::decode(
            Some("sessionKey=agent%3Amain%3Acron%3Ajob-1"),
            &decision("history:default"),
            &mut verifier,
            1,
        )
        .unwrap();
        assert_eq!(query.limit, DEFAULT_HISTORY_LIMIT);
    }

    #[test]
    fn cron_history_query_rejects_missing_duplicate_unknown_and_invalid_values() {
        for (correlation, query) in [
            ("history:missing", "limit=1"),
            ("history:duplicate-session", "sessionKey=a&sessionKey=b"),
            ("history:duplicate-limit", "sessionKey=a&limit=1&limit=2"),
            ("history:unknown", "sessionKey=a&other=value"),
            ("history:zero", "sessionKey=a&limit=0"),
            ("history:high", "sessionKey=a&limit=201"),
            ("history:decimal", "sessionKey=a&limit=1.5"),
            ("history:empty", "sessionKey=&limit=1"),
            ("history:malformed", "sessionKey=%FF&limit=1"),
        ] {
            let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
            assert_eq!(
                CronHistoryQuery::decode(Some(query), &decision(correlation), &mut verifier, 1,),
                Err(DecodeError::Invalid),
                "query {query} should be rejected",
            );
        }
    }

    #[test]
    fn cron_history_query_verifies_the_dedicated_capability_tuple() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert_eq!(
            CronHistoryQuery::decode(
                Some("sessionKey=a&limit=1"),
                &decision_with_capability("other.capability", "history:wrong-capability"),
                &mut verifier,
                1,
            ),
            Err(DecodeError::Unauthorized),
        );
    }

    fn signing_key() -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[37; 32])
    }

    fn verification_key() -> String {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(correlation: &str) -> String {
        decision_with_capability(HISTORY_CAPABILITY_ID, correlation)
    }

    fn decision_with_capability(capability: &str, correlation: &str) -> String {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        use ed25519_dalek::Signer as _;

        let payload = serde_json::json!({
            "version": 1,
            "principal": "electron-main-local",
            "endpoint": SESSION_HISTORY_PATH,
            "scope": HISTORY_SCOPE,
            "capability": capability,
            "subject": HISTORY_SUBJECT,
            "expiresAt": 60_000,
            "correlation": correlation,
            "revision": "1",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
