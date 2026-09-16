use serde::Deserialize;
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::{Component, Path},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

use crate::{
    cron::{
        CronBrokerContext, CronBrokerOperation, CronBrokerOutcome, CronBrokerRequest,
        CronBrokerResult, CronCreateCommand, CronDeleteCommand, CronDeliveryCommand,
        CronHistoryCommand, CronScheduleCommand, CronUpdateCommand,
    },
    facade::CronHandle,
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) const PATH: &str = "/api/cron/broker";
const ENDPOINT: &str = "runtime-host.cron.broker";
const CAPABILITY: &str = "app-server.cron.broker";
const SUBJECT: &str = "matcha-app-server";
const PRINCIPAL: &str = "matcha-app-server";
const OWNER: &str = "native-openclaw";
const MAX_LEDGER_ENTRIES: usize = 10_000;
const MAX_CWD_BYTES: usize = 32 * 1024;
const MAX_PAYLOAD_HASH_BYTES: usize = 64;
const MAX_HISTORY_LIMIT: u64 = 200;

#[derive(Debug)]
pub(crate) struct OperationLedger {
    entries: HashMap<String, LedgerEntry>,
    order: VecDeque<String>,
}

#[derive(Debug)]
struct LedgerEntry {
    payload_hash: String,
    request_id: String,
    state: LedgerState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LedgerState {
    InFlight,
    Unavailable,
    Completed,
}

pub(crate) fn new_operation_ledger() -> Arc<Mutex<OperationLedger>> {
    Arc::new(Mutex::new(OperationLedger {
        entries: HashMap::new(),
        order: VecDeque::new(),
    }))
}

pub(crate) async fn handle(
    request: super::server::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    cron: CronHandle,
    ledger: Arc<Mutex<OperationLedger>>,
) -> super::server::Response {
    if request.method != "POST" || request.path != PATH || request.query.is_some() {
        return super::server::Response::not_found();
    }
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == super::server::AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(super::server::BEARER_PREFIX))
    else {
        return super::server::Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return super::server::Response::bad_request(),
    };
    let request = match decode_request(value) {
        Ok(request) => request,
        Err(DecodeError::Invalid) => return super::server::Response::bad_request(),
    };
    let scope = request.scope();
    let decision = {
        let mut verifier = verifier.lock().await;
        match verifier.verify(
            authorization,
            now_millis(),
            ENDPOINT,
            scope,
            CAPABILITY,
            SUBJECT,
        ) {
            Ok(decision) => decision,
            Err(_) => return super::server::Response::unauthorized(),
        }
    };
    if decision.principal() != PRINCIPAL
        || decision.correlation() != request.request_id
        || decision.revision() != request.context_hash()
    {
        return super::server::Response::unauthorized();
    }

    let operation_id = request.operation_id.clone();
    let payload_hash = request.payload_hash.clone();
    let request_id = request.request_id.clone();
    {
        let mut ledger = ledger.lock().await;
        if let Some(entry) = ledger.entries.get(&operation_id) {
            if entry.payload_hash != payload_hash {
                return project_outcome(CronBrokerOutcome::Conflict {
                    code: "OPERATION_PAYLOAD_MISMATCH",
                    message: "Cron operationId was reused with a different payload",
                });
            }
            match entry.state {
                LedgerState::InFlight => {
                    return project_outcome(CronBrokerOutcome::Conflict {
                        code: "OPERATION_IN_FLIGHT",
                        message: "Cron operationId is already in flight",
                    });
                }
                LedgerState::Completed => {
                    return project_outcome(CronBrokerOutcome::Conflict {
                        code: "OPERATION_REPLAYED",
                        message: "Cron operationId has already been consumed",
                    });
                }
                LedgerState::Unavailable => {
                    if entry.request_id == request_id {
                        return project_outcome(CronBrokerOutcome::Conflict {
                            code: "OPERATION_REPLAYED",
                            message: "Cron operationId has already been consumed",
                        });
                    }
                }
            }
            if let Some(entry) = ledger.entries.get_mut(&operation_id) {
                entry.request_id = request_id.clone();
                entry.state = LedgerState::InFlight;
            }
        } else {
            ledger.entries.insert(
                operation_id.clone(),
                LedgerEntry {
                    payload_hash,
                    request_id,
                    state: LedgerState::InFlight,
                },
            );
            ledger.order.push_back(operation_id.clone());
        }
        while ledger.order.len() > MAX_LEDGER_ENTRIES {
            if let Some(oldest) = ledger.order.pop_front() {
                ledger.entries.remove(&oldest);
            }
        }
    }

    let outcome = execute(cron, request).await;
    let retryable = outcome.is_retryable();
    if let Some(entry) = ledger.lock().await.entries.get_mut(&operation_id) {
        entry.state = if retryable {
            LedgerState::Unavailable
        } else {
            LedgerState::Completed
        };
    }
    project_outcome(outcome)
}

async fn execute(cron: CronHandle, request: CronBrokerRequest) -> CronBrokerOutcome {
    match request.operation {
        CronBrokerOperation::List => {
            CronBrokerOutcome::Applied(CronBrokerResult::List(cron.list().await))
        }
        CronBrokerOperation::History { command } => {
            CronBrokerOutcome::Applied(CronBrokerResult::History(cron.load_history(command).await))
        }
        CronBrokerOperation::Create { command } => {
            CronBrokerOutcome::Applied(CronBrokerResult::Job(cron.create(command).await))
        }
        CronBrokerOperation::Update {
            command,
            expected_config_revision,
        } => {
            let command = match command.with_expected_config_revision(expected_config_revision) {
                Ok(command) => command,
                Err(_) => {
                    return CronBrokerOutcome::Rejected {
                        code: "INVALID_EXPECTED_CONFIG_REVISION",
                        message: "Cron expectedConfigRevision is invalid",
                    };
                }
            };
            CronBrokerOutcome::Applied(CronBrokerResult::Job(cron.update(command).await))
        }
        CronBrokerOperation::Delete => CronBrokerOutcome::Conflict {
            code: "DELETE_PRECONDITION_UNSUPPORTED",
            message: "Cron delete cannot safely apply expectedRevision",
        },
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DecodeError {
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRequest {
    version: u8,
    request_id: String,
    operation_id: String,
    operation: String,
    session_id: String,
    cwd: String,
    owner: String,
    target: Value,
    input: Value,
    expected_revision: Option<String>,
    payload_hash: String,
    context_hash: String,
}

fn decode_request(value: Value) -> Result<CronBrokerRequest, DecodeError> {
    let wire = serde_json::from_value::<WireRequest>(value).map_err(|_| DecodeError::Invalid)?;
    if wire.version != 1
        || wire.owner != OWNER
        || !opaque(&wire.request_id)
        || !opaque(&wire.operation_id)
        || !opaque(&wire.session_id)
        || !canonical_cwd(&wire.cwd)
        || wire.payload_hash.len() != MAX_PAYLOAD_HASH_BYTES
        || !wire
            .payload_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || wire
            .payload_hash
            .bytes()
            .any(|byte| byte.is_ascii_uppercase())
    {
        return Err(DecodeError::Invalid);
    }
    let payload = serde_json::json!({
        "operation": wire.operation,
        "target": wire.target,
        "input": wire.input,
        "expectedRevision": wire.expected_revision,
    });
    if sha256_hex(&crate::cron::canonical_json(&payload)) != wire.payload_hash {
        return Err(DecodeError::Invalid);
    }
    let context = serde_json::json!({
        "version": wire.version,
        "requestId": wire.request_id,
        "operationId": wire.operation_id,
        "operation": wire.operation,
        "sessionId": wire.session_id,
        "cwd": wire.cwd,
        "owner": wire.owner,
        "expectedRevision": wire.expected_revision,
        "target": wire.target,
        "input": wire.input,
        "payloadHash": wire.payload_hash,
    });
    if sha256_hex(&crate::cron::canonical_json(&context)) != wire.context_hash {
        return Err(DecodeError::Invalid);
    }

    let operation = match wire.operation.as_str() {
        "list" => {
            if !wire.target.is_null()
                || wire.expected_revision.is_some()
                || !is_empty_object(&wire.input)
            {
                return Err(DecodeError::Invalid);
            }
            CronBrokerOperation::List
        }
        "history" => {
            if wire.expected_revision.is_some() {
                return Err(DecodeError::Invalid);
            }
            let target = job_target(&wire.target)?;
            let run_session_id = optional_string(&wire.input, "runSessionId")?;
            let session_key = match run_session_id {
                Some(run_session_id) => {
                    format!("agent:main:cron:{}:run:{run_session_id}", target.job_id)
                }
                None => format!("agent:main:cron:{}", target.job_id),
            };
            let command = CronHistoryCommand::try_new(session_key, MAX_HISTORY_LIMIT)
                .map_err(|_| DecodeError::Invalid)?;
            CronBrokerOperation::History { command }
        }
        "create" => {
            if !wire.target.is_null() || wire.expected_revision.is_some() {
                return Err(DecodeError::Invalid);
            }
            CronBrokerOperation::Create {
                command: create_command(wire.input)?,
            }
        }
        "update" => {
            let expected_revision = expected_revision(wire.expected_revision.as_deref())?;
            let target = job_target(&wire.target)?;
            CronBrokerOperation::Update {
                command: update_command(target.job_id, wire.input)?,
                expected_config_revision: expected_revision,
            }
        }
        "delete" => {
            let expected_revision = expected_revision(wire.expected_revision.as_deref())?;
            let target = job_target(&wire.target)?;
            if !is_empty_object(&wire.input) {
                return Err(DecodeError::Invalid);
            }
            CronDeleteCommand::try_new(target.job_id).map_err(|_| DecodeError::Invalid)?;
            let _ = expected_revision;
            CronBrokerOperation::Delete
        }
        _ => return Err(DecodeError::Invalid),
    };

    Ok(CronBrokerRequest {
        request_id: wire.request_id,
        operation_id: wire.operation_id,
        context: CronBrokerContext {
            session_id: wire.session_id,
            cwd: wire.cwd,
            owner: wire.owner,
            target: payload["target"].clone(),
            input: payload["input"].clone(),
            expected_revision: payload["expectedRevision"].as_str().map(str::to_owned),
        },
        payload_hash: wire.payload_hash,
        operation,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobTarget {
    job_id: String,
}

fn job_target(value: &Value) -> Result<JobTarget, DecodeError> {
    let target =
        serde_json::from_value::<JobTarget>(value.clone()).map_err(|_| DecodeError::Invalid)?;
    if !opaque(&target.job_id) {
        return Err(DecodeError::Invalid);
    }
    Ok(target)
}

fn expected_revision(value: Option<&str>) -> Result<String, DecodeError> {
    value
        .filter(|value| opaque(value))
        .map(str::to_owned)
        .ok_or(DecodeError::Invalid)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    name: String,
    agent_id: String,
    message: String,
    schedule: ScheduleInput,
    delivery: DeliveryInput,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateInput {
    name: Option<String>,
    agent_id: Option<String>,
    message: Option<String>,
    schedule: Option<ScheduleInput>,
    delivery: Option<DeliveryInput>,
    enabled: Option<bool>,
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
    #[serde(rename = "none")]
    None,
    Announce {
        channel: String,
        to: String,
        account_id: String,
    },
}

impl DeliveryInput {
    fn into_command(self) -> CronDeliveryCommand {
        match self {
            Self::None => CronDeliveryCommand::None,
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

fn reject_null_schedule_fields(value: &Value) -> Result<(), DecodeError> {
    let Some(schedule) = value.get("schedule") else {
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

fn create_command(value: Value) -> Result<CronCreateCommand, DecodeError> {
    reject_null_schedule_fields(&value)?;
    let input = serde_json::from_value::<CreateInput>(value).map_err(|_| DecodeError::Invalid)?;
    CronCreateCommand::try_new(
        input.name,
        input.agent_id,
        input.message,
        None,
        input.schedule.into_command(),
        input.delivery.into_command(),
        input.enabled,
    )
    .map_err(|_| DecodeError::Invalid)
}

fn update_command(job_id: String, value: Value) -> Result<CronUpdateCommand, DecodeError> {
    reject_null_schedule_fields(&value)?;
    let input =
        serde_json::from_value::<UpdateInput>(value.clone()).map_err(|_| DecodeError::Invalid)?;
    let object = value.as_object().ok_or(DecodeError::Invalid)?;
    for key in [
        "name", "agentId", "message", "schedule", "delivery", "enabled",
    ] {
        if object.get(key).is_some_and(Value::is_null) {
            return Err(DecodeError::Invalid);
        }
    }
    CronUpdateCommand::try_new(
        job_id,
        input.name,
        input.agent_id,
        input.message,
        None,
        input.schedule.map(ScheduleInput::into_command),
        input.delivery.map(DeliveryInput::into_command),
        input.enabled,
    )
    .map_err(|_| DecodeError::Invalid)
}

fn optional_string(value: &Value, key: &str) -> Result<Option<String>, DecodeError> {
    let object = value.as_object().ok_or(DecodeError::Invalid)?;
    if object.keys().any(|name| name != key) {
        return Err(DecodeError::Invalid);
    }
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if opaque(value) => Ok(Some(value.clone())),
        Some(_) => Err(DecodeError::Invalid),
    }
}

fn is_empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(Map::is_empty)
}

fn opaque(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains('\0')
}

fn canonical_cwd(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_CWD_BYTES
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        return false;
    }
    let path = Path::new(value);
    path.is_absolute()
        && path
            .components()
            .all(|component| !matches!(component, Component::CurDir | Component::ParentDir))
}

fn sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};

    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn project_outcome(outcome: CronBrokerOutcome) -> super::server::Response {
    let (status, body) = match outcome {
        CronBrokerOutcome::Applied(result) => project_result(result),
        CronBrokerOutcome::Rejected { code, message } => rejected_response(code, message),
        CronBrokerOutcome::Conflict { code, message } => (
            409,
            serde_json::json!({
                "outcome": "conflict",
                "error": { "code": code, "message": message, "retryable": false }
            }),
        ),
    };
    super::server::Response { status, body }
}

fn project_result(result: CronBrokerResult) -> (u16, Value) {
    match result {
        CronBrokerResult::List(outcome) => match outcome {
            crate::cron::CronListOutcome::Listed(jobs) => {
                let Some(jobs) = jobs
                    .jobs
                    .into_iter()
                    .map(project_job)
                    .collect::<Option<Vec<_>>>()
                else {
                    return unknown_response(
                        "NATIVE_OUTCOME_UNKNOWN",
                        "Cron list result could not be projected",
                    );
                };
                applied_response(serde_json::json!({ "jobs": jobs }))
            }
            crate::cron::CronListOutcome::Unavailable => {
                unavailable_response("CRON_UNAVAILABLE", "Cron list is unavailable")
            }
            crate::cron::CronListOutcome::Rejected => {
                rejected_response("CRON_REJECTED", "Cron list was rejected")
            }
            crate::cron::CronListOutcome::Protocol => {
                unknown_response("CRON_PROTOCOL", "Cron list response is invalid")
            }
        },
        CronBrokerResult::History(outcome) => match outcome {
            crate::cron::CronHistoryOutcome::Loaded(history) => {
                applied_response(project_history(history))
            }
            crate::cron::CronHistoryOutcome::Rejected => {
                rejected_response("CRON_HISTORY_REJECTED", "Cron history was rejected")
            }
            crate::cron::CronHistoryOutcome::Protocol => {
                unknown_response("CRON_HISTORY_PROTOCOL", "Cron history response is invalid")
            }
            crate::cron::CronHistoryOutcome::Unavailable => {
                unavailable_response("CRON_HISTORY_UNAVAILABLE", "Cron history is unavailable")
            }
            crate::cron::CronHistoryOutcome::Deadline => unavailable_response(
                "CRON_HISTORY_DEADLINE",
                "Cron history deadline was exceeded",
            ),
        },
        CronBrokerResult::Job(outcome) => match outcome {
            crate::cron::CronJobMutationOutcome::Applied(job) => match project_job(*job) {
                Some(job) => applied_response(job),
                None => unknown_response(
                    "NATIVE_OUTCOME_UNKNOWN",
                    "Cron mutation result could not be projected",
                ),
            },
            crate::cron::CronJobMutationOutcome::Rejected => {
                rejected_response("CRON_MUTATION_REJECTED", "Cron mutation was rejected")
            }
            crate::cron::CronJobMutationOutcome::OutcomeUnknown => unknown_response(
                "CRON_MUTATION_OUTCOME_UNKNOWN",
                "Cron mutation outcome is unknown",
            ),
            crate::cron::CronJobMutationOutcome::Unavailable => {
                unavailable_response("CRON_MUTATION_UNAVAILABLE", "Cron mutation is unavailable")
            }
        },
    }
}

fn project_job(job: crate::cron::CronJobView) -> Option<Value> {
    let revision = job.updated_at_ms.to_string();
    let mut value = super::project_job_response(super::JobResponse::try_from(job).ok()?);
    value["revision"] = Value::String(revision);
    Some(value)
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

fn applied_response(result: Value) -> (u16, Value) {
    (
        200,
        serde_json::json!({ "outcome": "applied", "result": result }),
    )
}

fn rejected_response(code: &'static str, message: &'static str) -> (u16, Value) {
    (
        422,
        serde_json::json!({
            "outcome": "rejected",
            "error": { "code": code, "message": message, "retryable": false }
        }),
    )
}

fn unavailable_response(code: &'static str, message: &'static str) -> (u16, Value) {
    (
        503,
        serde_json::json!({
            "outcome": "unavailable",
            "error": { "code": code, "message": message, "retryable": true }
        }),
    )
}

fn unknown_response(code: &'static str, message: &'static str) -> (u16, Value) {
    (
        502,
        serde_json::json!({
            "outcome": "unknown",
            "error": {
                "code": code,
                "message": message,
                "retryable": false,
                "action": "reconcile"
            }
        }),
    )
}
