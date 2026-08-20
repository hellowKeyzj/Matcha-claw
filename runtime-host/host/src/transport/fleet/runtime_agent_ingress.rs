use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tokio::time::timeout;

const PATH: &str = "/api/remote-fleet/runtime-agent/ingress";
const ENROLLMENT_HEADER: &str = "x-matchaclaw-runtime-agent-ingress-credential";
const AUTHORIZATION_HEADER: &str = "authorization";
const MAX_BODY_BYTES: usize = 64 * 1024;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug)]
enum ParsedIngressRequest {
    Heartbeat {
        heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat,
    },
    Progress {
        correlation: fleet::runtime_agent::CommandCorrelation,
        progress: fleet::runtime_agent::RuntimeAgentProgress,
        reported_at: SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    },
    Result {
        correlation: fleet::runtime_agent::CommandCorrelation,
        result: fleet::runtime_agent::RuntimeAgentResult,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    },
}

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    owner: &crate::owner::Handle,
) -> Option<(u16, Value)> {
    if path != PATH {
        return None;
    }
    if !is_ingress_route(method, path) {
        return Some(rejected(None, "invalid-request", 405));
    }
    if !body_within_limit(body) {
        return Some(rejected(None, "invalid-request", 413));
    }
    if !is_json_content_type(header(headers, "content-type")) {
        return Some(rejected(None, "invalid-request", 400));
    }
    let request = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => return Some(rejected(None, "invalid-request", 400)),
    };
    let record = match request.as_object() {
        Some(record) => record,
        None => return Some(rejected(Some(&request), "invalid-request", 400)),
    };
    let request_type = match required_string(record, "type") {
        Ok(value) => value,
        Err(_) => return Some(rejected(Some(&request), "invalid-request", 400)),
    };
    if !matches!(
        request_type,
        "runtime-agent.heartbeat"
            | "runtime-agent.command.progress"
            | "runtime-agent.command.result"
    ) {
        return Some(rejected(Some(&request), "unsupported-operation", 422));
    }
    let request_id = match required_string(record, "requestId") {
        Ok(value) => value,
        Err(_) => return Some(rejected(Some(&request), "invalid-request", 400)),
    };
    let agent_id = match required_string(record, "agentId")
        .ok()
        .and_then(|value| platform::endpoint::NativeAgentId::try_new(value).ok())
    {
        Some(value) => value,
        None => return Some(rejected(Some(&request), "invalid-request", 400)),
    };
    if required_string(record, "sentAt").is_err() {
        return Some(rejected(Some(&request), "invalid-request", 400));
    }
    let parsed = match parse_operation(request_type, record) {
        Ok(value) => value,
        Err(_) => return Some(rejected(Some(&request), "invalid-request", 400)),
    };
    let bearer = match bearer(header(headers, AUTHORIZATION_HEADER)) {
        Some(value) => value,
        None => return Some(rejected(Some(&request), "unauthorized", 401)),
    };
    let enrollment = if request_type == "runtime-agent.heartbeat" {
        header(headers, ENROLLMENT_HEADER).and_then(|value| {
            let value = value.trim();
            (!value.is_empty()).then_some(value)
        })
    } else {
        None
    };
    let presented_hash = match fleet::FleetDeliveryOwner::hash_ingress_credential(bearer) {
        Ok(hash) => hash,
        Err(_) => return Some(rejected(Some(&request), "unauthorized", 401)),
    };
    let enrollment_hash = match enrollment
        .map(fleet::FleetDeliveryOwner::hash_ingress_credential)
        .transpose()
    {
        Ok(hash) => hash,
        Err(_) => return Some(rejected(Some(&request), "unauthorized", 401)),
    };
    match timeout(
        REQUEST_DEADLINE,
        authenticate_runtime_agent_ingress(
            owner,
            agent_id.clone(),
            presented_hash,
            enrollment_hash,
        ),
    )
    .await
    {
        Ok(Ok(fleet::store::IngressAuthentication::Authenticated { .. })) => {}
        Ok(Ok(fleet::store::IngressAuthentication::Unauthorized)) => {
            return Some(rejected(Some(&request), "unauthorized", 401));
        }
        Ok(Err(())) | Err(_) => {
            return Some(rejected(Some(&request), "runtime-unavailable", 503));
        }
    }
    let result = match parsed {
        ParsedIngressRequest::Heartbeat {
            heartbeat: heartbeat_value,
        } => heartbeat(request_id, agent_id, heartbeat_value, owner).await,
        ParsedIngressRequest::Progress {
            correlation,
            progress: progress_value,
            reported_at,
            command_attempt,
            dispatch_attempt,
        } => {
            progress(
                request_id,
                agent_id,
                correlation,
                progress_value,
                reported_at,
                command_attempt,
                dispatch_attempt,
                owner,
            )
            .await
        }
        ParsedIngressRequest::Result {
            correlation,
            result: result_value,
            command_attempt,
            dispatch_attempt,
        } => {
            result(
                request_id,
                agent_id,
                correlation,
                result_value,
                command_attempt,
                dispatch_attempt,
                owner,
            )
            .await
        }
    };
    Some(result)
}

async fn authenticate_runtime_agent_ingress(
    owner: &crate::owner::Handle,
    agent_id: fleet::runtime_agent::RuntimeAgentId,
    presented_hash: fleet::topology::CredentialHash,
    enrollment_hash: Option<fleet::topology::CredentialHash>,
) -> Result<fleet::store::IngressAuthentication, ()> {
    let at = SystemTime::now();
    let initial = owner
        .fleet_authenticate_runtime_agent_ingress(fleet::store::AgentIngressIdentity::new(
            agent_id.clone(),
            presented_hash.clone(),
            None,
            at,
        ))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    if matches!(
        &initial,
        fleet::store::IngressAuthentication::Authenticated { .. }
    ) {
        return Ok(initial);
    }
    let Some(enrollment_hash) = enrollment_hash else {
        return Ok(initial);
    };
    owner
        .fleet_authenticate_runtime_agent_ingress(fleet::store::AgentIngressIdentity::new(
            agent_id,
            presented_hash,
            Some(enrollment_hash),
            at,
        ))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn heartbeat(
    request_id: &str,
    agent_id: fleet::runtime_agent::RuntimeAgentId,
    heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat,
    owner: &crate::owner::Handle,
) -> (u16, Value) {
    let status = heartbeat.status();
    let observed_at = heartbeat.observed_at();
    let runtime_ids = heartbeat
        .runtime_ids()
        .iter()
        .map(|id| id.as_str().to_owned())
        .collect::<Vec<_>>();
    match owner
        .fleet_record_runtime_agent_heartbeat(agent_id.clone(), heartbeat)
        .await
    {
        Ok(Ok(_)) => (
            200,
            serde_json::json!({
                "type": "runtime-agent.heartbeat.response",
                "requestId": request_id,
                "agentId": agent_id.as_str(),
                "resultType": "recorded",
                "receivedAt": now_iso(),
                "snapshot": {"agentId": agent_id.as_str(), "status": status_name(status), "observedAt": iso(observed_at), "runtimeIds": runtime_ids}
            }),
        ),
        Ok(Err(error)) => rejected_error_for_request(
            request_id,
            agent_id.as_str(),
            "runtime-agent.heartbeat.response",
            error,
        ),
        Err(_) => rejected_for_request(
            request_id,
            agent_id.as_str(),
            "runtime-agent.heartbeat.response",
            "runtime-unavailable",
            503,
        ),
    }
}

async fn progress(
    request_id: &str,
    agent_id: fleet::runtime_agent::RuntimeAgentId,
    correlation: fleet::runtime_agent::CommandCorrelation,
    progress: fleet::runtime_agent::RuntimeAgentProgress,
    reported_at: SystemTime,
    command_attempt: fleet::command::CommandAttempt,
    dispatch_attempt: fleet::outbox::DispatchAttempt,
    owner: &crate::owner::Handle,
) -> (u16, Value) {
    let command_id = correlation.command_id().as_str().to_owned();
    match owner
        .fleet_record_runtime_agent_progress(
            agent_id.clone(),
            correlation,
            progress,
            reported_at,
            command_attempt,
            dispatch_attempt,
        )
        .await
    {
        Ok(Ok(_)) => (
            200,
            serde_json::json!({"type":"runtime-agent.command.progress.response","requestId":request_id,"agentId":agent_id.as_str(),"commandId":command_id,"resultType":"recorded","recordedAt":now_iso()}),
        ),
        Ok(Err(error)) => rejected_error_for_request(
            request_id,
            agent_id.as_str(),
            "runtime-agent.command.progress.response",
            error,
        ),
        Err(_) => rejected_for_request(
            request_id,
            agent_id.as_str(),
            "runtime-agent.command.progress.response",
            "runtime-unavailable",
            503,
        ),
    }
}

async fn result(
    request_id: &str,
    agent_id: fleet::runtime_agent::RuntimeAgentId,
    correlation: fleet::runtime_agent::CommandCorrelation,
    result: fleet::runtime_agent::RuntimeAgentResult,
    command_attempt: fleet::command::CommandAttempt,
    dispatch_attempt: fleet::outbox::DispatchAttempt,
    owner: &crate::owner::Handle,
) -> (u16, Value) {
    let command_id = correlation.command_id().as_str().to_owned();
    match owner
        .fleet_record_runtime_agent_result(
            agent_id.clone(),
            correlation,
            result,
            command_attempt,
            dispatch_attempt,
        )
        .await
    {
        Ok(Ok(_)) => (
            200,
            serde_json::json!({"type":"runtime-agent.command.result.response","requestId":request_id,"agentId":agent_id.as_str(),"commandId":command_id,"resultType":"recorded","recordedAt":now_iso()}),
        ),
        Ok(Err(error)) => rejected_error_for_request(
            request_id,
            agent_id.as_str(),
            "runtime-agent.command.result.response",
            error,
        ),
        Err(_) => rejected_for_request(
            request_id,
            agent_id.as_str(),
            "runtime-agent.command.result.response",
            "runtime-unavailable",
            503,
        ),
    }
}

fn parse_operation(
    request_type: &str,
    record: &Map<String, Value>,
) -> Result<ParsedIngressRequest, ()> {
    match request_type {
        "runtime-agent.heartbeat" => {
            let observed_at = timestamp(record, "observedAt")?;
            let status = required_string(record, "status")
                .ok()
                .and_then(parse_status)
                .ok_or(())?;
            let runtime_ids = match record.get("runtimeIds") {
                None => Vec::new(),
                Some(Value::Array(values)) => values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .and_then(|value| fleet::runtime_agent::RuntimeId::try_new(value).ok())
                            .ok_or(())
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                Some(_) => return Err(()),
            };
            let message = optional_message(record, "message")?;
            Ok(ParsedIngressRequest::Heartbeat {
                heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat::try_new(
                    observed_at,
                    status,
                    runtime_ids,
                    message,
                )
                .map_err(|_| ())?,
            })
        }
        "runtime-agent.command.progress" => {
            let (correlation, reported_at, command_attempt, dispatch_attempt) =
                common_command(record)?;
            let progress_record = record
                .get("progress")
                .and_then(Value::as_object)
                .ok_or(())?;
            let state = required_string(progress_record, "state")
                .ok()
                .and_then(parse_progress_state)
                .ok_or(())?;
            let phase = optional_phase(progress_record, "phase")?;
            let message = optional_message(progress_record, "message")?;
            let percent = match progress_record.get("percent") {
                None => None,
                Some(value) => Some(value.as_u64().filter(|value| *value <= 100).ok_or(())? as u8),
            };
            Ok(ParsedIngressRequest::Progress {
                correlation,
                progress: fleet::runtime_agent::RuntimeAgentProgress::new(
                    state, phase, message, percent,
                ),
                reported_at,
                command_attempt,
                dispatch_attempt,
            })
        }
        "runtime-agent.command.result" => {
            let (correlation, _sent_at, command_attempt, dispatch_attempt) =
                common_command(record)?;
            Ok(ParsedIngressRequest::Result {
                correlation,
                result: parse_result(record.get("result"))?,
                command_attempt,
                dispatch_attempt,
            })
        }
        _ => Err(()),
    }
}

fn common_command(
    record: &Map<String, Value>,
) -> Result<
    (
        fleet::runtime_agent::CommandCorrelation,
        SystemTime,
        fleet::command::CommandAttempt,
        fleet::outbox::DispatchAttempt,
    ),
    (),
> {
    let command_id = fleet::command::CommandId::try_new(required_string(record, "commandId")?)
        .map_err(|_| ())?;
    let key = fleet::command::IdempotencyKey::try_new(required_string(record, "idempotencyKey")?)
        .map_err(|_| ())?;
    let sent_at = timestamp(record, "sentAt")?;
    let command_attempt = fleet::command::CommandAttempt::try_new(
        record
            .get("commandAttempt")
            .and_then(Value::as_u64)
            .ok_or(())?,
    )
    .map_err(|_| ())?;
    let dispatch_attempt = fleet::outbox::DispatchAttempt::try_new(
        record
            .get("dispatchAttempt")
            .and_then(Value::as_u64)
            .ok_or(())?,
    )
    .map_err(|_| ())?;
    Ok((
        fleet::runtime_agent::CommandCorrelation::new(command_id, key),
        sent_at,
        command_attempt,
        dispatch_attempt,
    ))
}

fn parse_result(value: Option<&Value>) -> Result<fleet::runtime_agent::RuntimeAgentResult, ()> {
    let record = value.and_then(Value::as_object).ok_or(())?;
    let reason = required_string(record, "reason")?;
    let completed_at = timestamp(record, "completedAt")?;
    match reason {
        "succeeded" => Ok(fleet::runtime_agent::RuntimeAgentResult::Succeeded { completed_at }),
        "failed" => Ok(fleet::runtime_agent::RuntimeAgentResult::Failed {
            completed_at,
            message: fleet::runtime_agent::OperatorMessage::try_new(required_string(
                record, "message",
            )?)
            .map_err(|_| ())?,
        }),
        "cancelled" => Ok(fleet::runtime_agent::RuntimeAgentResult::Cancelled {
            completed_at,
            message: optional_message(record, "message")?,
        }),
        "timed-out" => Ok(fleet::runtime_agent::RuntimeAgentResult::TimedOut {
            completed_at,
            timeout: Duration::from_millis(
                record
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .filter(|value| *value > 0)
                    .ok_or(())?,
            ),
        }),
        _ => Err(()),
    }
}

fn parse_status(value: &str) -> Option<fleet::runtime_agent::RuntimeAgentStatus> {
    Some(match value {
        "starting" => fleet::runtime_agent::RuntimeAgentStatus::Starting,
        "running" => fleet::runtime_agent::RuntimeAgentStatus::Running,
        "draining" => fleet::runtime_agent::RuntimeAgentStatus::Draining,
        "stopping" => fleet::runtime_agent::RuntimeAgentStatus::Stopping,
        "stopped" => fleet::runtime_agent::RuntimeAgentStatus::Stopped,
        "degraded" => fleet::runtime_agent::RuntimeAgentStatus::Degraded,
        _ => return None,
    })
}
fn status_name(value: fleet::runtime_agent::RuntimeAgentStatus) -> &'static str {
    match value {
        fleet::runtime_agent::RuntimeAgentStatus::Starting => "starting",
        fleet::runtime_agent::RuntimeAgentStatus::Running => "running",
        fleet::runtime_agent::RuntimeAgentStatus::Draining => "draining",
        fleet::runtime_agent::RuntimeAgentStatus::Stopping => "stopping",
        fleet::runtime_agent::RuntimeAgentStatus::Stopped => "stopped",
        fleet::runtime_agent::RuntimeAgentStatus::Degraded => "degraded",
    }
}
fn parse_progress_state(value: &str) -> Option<fleet::runtime_agent::RuntimeAgentProgressState> {
    match value {
        "queued" => Some(fleet::runtime_agent::RuntimeAgentProgressState::Queued),
        "running" => Some(fleet::runtime_agent::RuntimeAgentProgressState::Running),
        _ => None,
    }
}
fn required_string<'a>(record: &'a Map<String, Value>, field: &str) -> Result<&'a str, ()> {
    record
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(())
}
fn optional_message(
    record: &Map<String, Value>,
    field: &str,
) -> Result<Option<fleet::runtime_agent::OperatorMessage>, ()> {
    record
        .get(field)
        .map(|value| {
            value.as_str().ok_or(()).and_then(|value| {
                fleet::runtime_agent::OperatorMessage::try_new(value).map_err(|_| ())
            })
        })
        .transpose()
}
fn optional_phase(
    record: &Map<String, Value>,
    field: &str,
) -> Result<Option<fleet::runtime_agent::ProgressPhase>, ()> {
    record
        .get(field)
        .map(|value| {
            value.as_str().ok_or(()).and_then(|value| {
                fleet::runtime_agent::ProgressPhase::try_new(value).map_err(|_| ())
            })
        })
        .transpose()
}
fn timestamp(record: &Map<String, Value>, field: &str) -> Result<SystemTime, ()> {
    let value = required_string(record, field)?;
    let millis = chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| ())?
        .timestamp_millis();
    u64::try_from(millis)
        .map(|value| UNIX_EPOCH + Duration::from_millis(value))
        .map_err(|_| ())
}
fn iso(value: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(value).to_rfc3339()
}
fn now_iso() -> String {
    iso(SystemTime::now())
}
fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}
fn bearer(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    let (scheme, credential) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(credential.trim())
        .filter(|credential| !credential.is_empty())
}
fn is_ingress_route(method: &str, path: &str) -> bool {
    method == "POST" && path == PATH
}

fn body_within_limit(body: &[u8]) -> bool {
    body.len() <= MAX_BODY_BYTES
}

fn response_type(request_type: Option<&str>) -> &'static str {
    match request_type {
        Some("runtime-agent.heartbeat") => "runtime-agent.heartbeat.response",
        Some("runtime-agent.command.progress") => "runtime-agent.command.progress.response",
        Some("runtime-agent.command.result") => "runtime-agent.command.result.response",
        Some("runtime-agent.command.accept") => "runtime-agent.command.accept.response",
        _ => "runtime-agent.ingress.response",
    }
}

fn is_json_content_type(value: Option<&str>) -> bool {
    value
        .map(|value| {
            value
                .to_ascii_lowercase()
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                == "application/json"
        })
        .unwrap_or(false)
}
fn rejected(request: Option<&Value>, reason: &str, status: u16) -> (u16, Value) {
    rejected_value(request, reason, status)
}
fn rejected_error_for_request(
    request_id: &str,
    agent_id: &str,
    response_type: &str,
    error: fleet::FleetDeliveryError,
) -> (u16, Value) {
    let reason = match error {
        fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::StaleHeartbeat,
        )
        | fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::StaleProgress,
        )
        | fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::StaleResult,
        ) => "command-conflict",
        fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::AgentMismatch,
        ) => "unauthorized",
        fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::UnknownCommand,
        )
        | fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::CorrelationMismatch,
        )
        | fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::AttemptRequired,
        )
        | fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::AttemptMismatch,
        )
        | fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::TerminalCommand,
        )
        | fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::ConflictingTerminalResult,
        )
        | fleet::FleetDeliveryError::RuntimeAgentNotFound
        | fleet::FleetDeliveryError::CommandNotFound
        | fleet::FleetDeliveryError::DispatchNotFound
        | fleet::FleetDeliveryError::AttemptConflict => "command-conflict",
        fleet::FleetDeliveryError::RuntimeAgent(
            fleet::runtime_agent::RuntimeAgentError::InvalidProgressTransition,
        ) => "invalid-request",
        _ => "runtime-unavailable",
    };
    rejected_for_request(
        request_id,
        agent_id,
        response_type,
        reason,
        if reason == "command-conflict" {
            409
        } else if reason == "unauthorized" {
            401
        } else if reason == "invalid-request" {
            400
        } else {
            503
        },
    )
}

fn rejected_for_request(
    request_id: &str,
    agent_id: &str,
    response_type: &str,
    reason: &str,
    status: u16,
) -> (u16, Value) {
    (
        status,
        serde_json::json!({
            "type": response_type,
            "requestId": request_id,
            "agentId": agent_id,
            "resultType": "rejected",
            "reason": reason,
            "message": reason,
        }),
    )
}

fn rejected_value(request: Option<&Value>, reason: &str, status: u16) -> (u16, Value) {
    let record = request.and_then(Value::as_object);
    let request_id = record
        .and_then(|r| r.get("requestId"))
        .and_then(Value::as_str)
        .unwrap_or("invalid-request");
    let agent_id = record
        .and_then(|r| r.get("agentId"))
        .and_then(Value::as_str);
    let response_type = response_type(record.and_then(|r| r.get("type")).and_then(Value::as_str));
    let mut body = serde_json::json!({"type":response_type,"requestId":request_id,"resultType":"rejected","reason":reason,"message":reason});
    if let Some(agent_id) = agent_id {
        body["agentId"] = Value::String(agent_id.to_owned());
    }
    (status, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_agent_listener_rejects_outbound_accept_with_typed_response() {
        let request = serde_json::json!({
            "type": "runtime-agent.command.accept",
            "requestId": "request-accept-1",
            "agentId": "agent-ingress-1",
            "sentAt": iso(at(10)),
            "commandId": "command-ingress-1",
            "idempotencyKey": "idem-ingress-1",
            "commandAttempt": 1,
            "dispatchAttempt": 1
        });

        let (status, body) = rejected(Some(&request), "unsupported-operation", 422);

        assert_eq!(status, 422);
        assert_eq!(body["type"], "runtime-agent.command.accept.response");
        assert_eq!(body["requestId"], "request-accept-1");
        assert_eq!(body["agentId"], "agent-ingress-1");
        assert_eq!(body["resultType"], "rejected");
        assert_eq!(body["reason"], "unsupported-operation");
        assert!(
            parse_operation("runtime-agent.command.accept", request.as_object().unwrap()).is_err()
        );
    }

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn ingress_boundary_helpers_are_exact() {
        assert!(is_ingress_route("POST", PATH));
        assert!(!is_ingress_route("GET", PATH));
        assert!(!is_ingress_route("POST", "/api/fleet"));
        assert!(body_within_limit(&vec![0; MAX_BODY_BYTES]));
        assert!(!body_within_limit(&vec![0; MAX_BODY_BYTES + 1]));
        assert!(is_json_content_type(Some(
            "application/json; charset=utf-8"
        )));
        assert!(!is_json_content_type(Some("text/json")));
        assert!(!is_json_content_type(None));
    }

    #[test]
    fn bearer_header_requires_a_non_empty_bearer_value() {
        assert_eq!(bearer(Some(" Bearer credential ")), Some("credential"));
        assert_eq!(bearer(Some("Basic credential")), None);
        assert_eq!(bearer(Some("Bearer")), None);
        assert_eq!(bearer(Some("Bearer   ")), None);
    }

    #[test]
    fn ingress_does_not_accept_outbound_command_admission() {
        let request = serde_json::json!({"type":"runtime-agent.command.accept"});
        let record = request.as_object().unwrap();
        assert!(parse_operation("runtime-agent.command.accept", record).is_err());
    }

    #[test]
    fn rejected_outbound_accept_uses_its_response_type_without_admitting_the_operation() {
        let request = serde_json::json!({
            "type": "runtime-agent.command.accept",
            "requestId": "request-1",
            "agentId": "agent-1",
        });
        let response = rejected(Some(&request), "unsupported-operation", 422);
        assert_eq!(response.1["type"], "runtime-agent.command.accept.response");
        assert_eq!(response.1["resultType"], "rejected");
        assert!(
            parse_operation("runtime-agent.command.accept", request.as_object().unwrap()).is_err()
        );
    }

    #[test]
    fn progress_envelope_requires_history_fields_and_nested_payload_shape() {
        let request = serde_json::json!({
            "type": "runtime-agent.command.progress",
            "requestId": "request-1",
            "agentId": "agent-1",
            "sentAt": "1970-01-01T00:00:01+00:00",
            "commandId": "command-1",
            "idempotencyKey": "idem-1",
            "commandAttempt": 2,
            "dispatchAttempt": 3,
            "progress": {
                "state": "running",
                "phase": "installing",
                "message": "installing runtime",
                "percent": 25,
            },
        });

        let ParsedIngressRequest::Progress {
            correlation,
            progress,
            reported_at,
            command_attempt,
            dispatch_attempt,
        } = parse_operation(
            "runtime-agent.command.progress",
            request.as_object().unwrap(),
        )
        .unwrap()
        else {
            panic!("expected progress request");
        };

        assert_eq!(correlation.command_id().as_str(), "command-1");
        assert_eq!(correlation.idempotency_key().as_str(), "idem-1");
        assert_eq!(reported_at, UNIX_EPOCH + Duration::from_secs(1));
        assert_eq!(command_attempt.sequence(), 2);
        assert_eq!(dispatch_attempt.sequence(), 3);
        assert_eq!(
            progress.state(),
            fleet::runtime_agent::RuntimeAgentProgressState::Running
        );
        assert_eq!(progress.phase().unwrap().as_str(), "installing");
        assert_eq!(progress.message().unwrap().as_str(), "installing runtime");
        assert_eq!(progress.percent(), Some(25));
        assert!(request.get("runtimeAgentProgress").is_none());
        assert!(request.get("payload").is_none());
    }

    #[test]
    fn result_envelope_requires_history_fields_and_terminal_payload_shape() {
        let request = serde_json::json!({
            "type": "runtime-agent.command.result",
            "requestId": "request-1",
            "agentId": "agent-1",
            "sentAt": "1970-01-01T00:00:01+00:00",
            "commandId": "command-1",
            "idempotencyKey": "idem-1",
            "commandAttempt": 2,
            "dispatchAttempt": 3,
            "result": {
                "reason": "timed-out",
                "completedAt": "1970-01-01T00:00:04+00:00",
                "timeoutMs": 500,
            },
        });

        let ParsedIngressRequest::Result {
            correlation,
            result,
            command_attempt,
            dispatch_attempt,
        } = parse_operation("runtime-agent.command.result", request.as_object().unwrap()).unwrap()
        else {
            panic!("expected result request");
        };

        assert_eq!(correlation.command_id().as_str(), "command-1");
        assert_eq!(correlation.idempotency_key().as_str(), "idem-1");
        assert_eq!(command_attempt.sequence(), 2);
        assert_eq!(dispatch_attempt.sequence(), 3);
        assert_eq!(
            result,
            fleet::runtime_agent::RuntimeAgentResult::TimedOut {
                completed_at: UNIX_EPOCH + Duration::from_secs(4),
                timeout: Duration::from_millis(500),
            }
        );
        assert!(request.get("runtimeAgentResult").is_none());
        assert!(request.get("payload").is_none());
    }

    #[test]
    fn stale_and_attempt_errors_use_existing_command_conflict_reason() {
        let response = rejected_error_for_request(
            "request-1",
            "agent-1",
            "runtime-agent.command.result.response",
            fleet::FleetDeliveryError::RuntimeAgent(
                fleet::runtime_agent::RuntimeAgentError::StaleResult,
            ),
        );
        assert_eq!(response.0, 409);
        assert_eq!(response.1["reason"], "command-conflict");

        let response = rejected_error_for_request(
            "request-2",
            "agent-1",
            "runtime-agent.command.result.response",
            fleet::FleetDeliveryError::RuntimeAgent(
                fleet::runtime_agent::RuntimeAgentError::AttemptMismatch,
            ),
        );
        assert_eq!(response.0, 409);
        assert_eq!(response.1["reason"], "command-conflict");
    }
}
