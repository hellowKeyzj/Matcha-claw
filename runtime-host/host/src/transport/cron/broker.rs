use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
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
        CronHistoryCommand, CronUpdateCommand,
    },
    facade::CronHandle,
    transport::authorization::CapabilityDecisionVerifier,
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
        Err(DecodeError::Unauthorized) => return super::server::Response::unauthorized(),
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
        || decision.revision() != context_hash(&request)
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
    let retryable = matches!(&outcome, CronBrokerOutcome::Unavailable { .. });
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
            let outcome = match cron.list().await {
                Ok(jobs) => crate::cron::CronListOutcome::Listed(jobs),
                Err(failure) => failure.into(),
            };
            CronBrokerOutcome::Applied(CronBrokerResult::List(outcome))
        }
        CronBrokerOperation::History { command } => {
            CronBrokerOutcome::Applied(CronBrokerResult::History(cron.load_history(command).await))
        }
        CronBrokerOperation::Create { command } => {
            CronBrokerOutcome::Applied(CronBrokerResult::Job(cron.create(command).await))
        }
        CronBrokerOperation::Update {
            command,
            expected_revision: _,
        } => CronBrokerOutcome::Applied(CronBrokerResult::Job(cron.update(command).await)),
        CronBrokerOperation::Delete {
            command,
            expected_revision: _,
        } => CronBrokerOutcome::Applied(CronBrokerResult::Delete(cron.delete(command).await)),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DecodeError {
    Invalid,
    Unauthorized,
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
    if sha256_hex(&canonical_json(&payload)) != wire.payload_hash {
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
    if sha256_hex(&canonical_json(&context)) != wire.context_hash {
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
            let expected_revision = wire
                .expected_revision
                .as_deref()
                .filter(|value| opaque(value))
                .ok_or(DecodeError::Invalid)?
                .to_owned();
            let target = job_target(&wire.target)?;
            CronBrokerOperation::Update {
                command: update_command(target.job_id, wire.input)?,
                expected_revision,
            }
        }
        "delete" => {
            let expected_revision = wire
                .expected_revision
                .as_deref()
                .filter(|value| opaque(value))
                .ok_or(DecodeError::Invalid)?
                .to_owned();
            let target = job_target(&wire.target)?;
            if !is_empty_object(&wire.input) {
                return Err(DecodeError::Invalid);
            }
            CronBrokerOperation::Delete {
                command: CronDeleteCommand::try_new(target.job_id)
                    .map_err(|_| DecodeError::Invalid)?,
                expected_revision,
            }
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    name: String,
    agent_id: String,
    message: String,
    schedule: String,
    delivery: DeliveryInput,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateInput {
    name: Option<String>,
    agent_id: Option<String>,
    message: Option<String>,
    schedule: Option<String>,
    delivery: Option<DeliveryInput>,
    enabled: Option<bool>,
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

fn create_command(value: Value) -> Result<CronCreateCommand, DecodeError> {
    let input = serde_json::from_value::<CreateInput>(value).map_err(|_| DecodeError::Invalid)?;
    CronCreateCommand::try_new(
        input.name,
        input.agent_id,
        input.message,
        input.schedule,
        input.delivery.into_command(),
        input.enabled,
    )
    .map_err(|_| DecodeError::Invalid)
}

fn update_command(job_id: String, value: Value) -> Result<CronUpdateCommand, DecodeError> {
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
        input.schedule,
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

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("JSON string is serializable"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key is serializable"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn context_hash(request: &CronBrokerRequest) -> String {
    let value = serde_json::json!({
        "version": 1,
        "requestId": request.request_id,
        "operationId": request.operation_id,
        "operation": operation_name(&request.operation),
        "sessionId": request.context.session_id,
        "cwd": request.context.cwd,
        "owner": request.context.owner,
        "expectedRevision": request.context.expected_revision,
        "target": request.context.target,
        "input": request.context.input,
        "payloadHash": request.payload_hash,
    });
    sha256_hex(&canonical_json(&value))
}

fn operation_name(operation: &CronBrokerOperation) -> &'static str {
    match operation {
        CronBrokerOperation::List => "list",
        CronBrokerOperation::History { .. } => "history",
        CronBrokerOperation::Create { .. } => "create",
        CronBrokerOperation::Update { .. } => "update",
        CronBrokerOperation::Delete { .. } => "delete",
    }
}

fn sha256_hex(value: &str) -> String {
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
        CronBrokerOutcome::Applied(result) => match project_result(result) {
            Some(result) => (
                200,
                serde_json::json!({ "outcome": "applied", "result": result }),
            ),
            None => unknown_response(
                "NATIVE_OUTCOME_UNKNOWN",
                "Cron result could not be projected",
            ),
        },
        CronBrokerOutcome::Rejected { code, message } => rejected_response(code, message),
        CronBrokerOutcome::Conflict { code, message } => (
            409,
            serde_json::json!({
                "outcome": "conflict",
                "error": { "code": code, "message": message, "retryable": false }
            }),
        ),
        CronBrokerOutcome::Unknown { code, message } => unknown_response(code, message),
        CronBrokerOutcome::Unavailable { code, message } => (
            503,
            serde_json::json!({
                "outcome": "unavailable",
                "error": { "code": code, "message": message, "retryable": true }
            }),
        ),
    };
    super::server::Response { status, body }
}

fn project_result(result: CronBrokerResult) -> Option<Value> {
    match result {
        CronBrokerResult::List(outcome) => match outcome {
            crate::cron::CronListOutcome::Listed(jobs) => {
                let jobs = jobs
                    .jobs
                    .into_iter()
                    .map(project_job)
                    .collect::<Option<Vec<_>>>()?;
                Some(serde_json::json!({ "jobs": jobs }))
            }
            crate::cron::CronListOutcome::Unavailable => None,
            crate::cron::CronListOutcome::Rejected | crate::cron::CronListOutcome::Protocol => None,
        },
        CronBrokerResult::History(outcome) => match outcome {
            crate::cron::CronHistoryOutcome::Loaded(history) => Some(
                serde_json::to_value(crate::openclaw_session::ChatHistoryResponse::from(history))
                    .ok()?,
            ),
            _ => None,
        },
        CronBrokerResult::Job(outcome) => match outcome {
            crate::cron::CronJobMutationOutcome::Applied(job) => project_job(*job),
            _ => None,
        },
        CronBrokerResult::Delete(outcome) => match outcome {
            crate::cron::CronDeleteOutcome::Applied(receipt) => {
                Some(serde_json::json!({ "removed": receipt.removed }))
            }
            _ => None,
        },
    }
}

fn project_job(job: openclaw::gateway::wire::CronJob) -> Option<Value> {
    let revision = job.updated_at_ms.to_string();
    let mut value = serde_json::to_value(super::JobResponse::try_from(job).ok()?).ok()?;
    value["revision"] = Value::String(revision);
    Some(value)
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
