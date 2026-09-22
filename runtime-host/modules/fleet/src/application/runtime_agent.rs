use std::time::Duration;

use crate as fleet;
use fleet::{
    FleetSecretResolution, FleetSecretResolverPort, RuntimeAgentEndpointConfig,
    reachability::RuntimeAgentCallbackEndpoint,
};
use serde_json::{Value, json};
use tokio::time::timeout;

const MAX_BODY_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeAgentOutcome {
    Accepted,
    Rejected,
    Unknown,
}

pub(crate) async fn dispatch<R: FleetSecretResolverPort>(
    endpoint: &RuntimeAgentEndpointConfig,
    callback: &RuntimeAgentCallbackEndpoint,
    agent_id: &platform::endpoint::NativeAgentId,
    command: &fleet::command::CommandIntent,
    dispatch_attempt: u64,
    resolver: &mut R,
) -> RuntimeAgentOutcome
where
    R::Secret: AsRef<str>,
{
    let token = match resolver.resolve(endpoint.token()) {
        Ok(FleetSecretResolution::Resolved(value)) => value,
        Ok(FleetSecretResolution::AccessDenied | FleetSecretResolution::NotFound) | Err(_) => {
            return RuntimeAgentOutcome::Rejected;
        }
    };
    let request_id = format!(
        "remote-fleet-command-{}-{}",
        command.command_id().as_str(),
        dispatch_attempt
    );
    let sent_at = chrono::Utc::now().to_rfc3339();
    let body = command_accept_envelope(&request_id, agent_id, command, dispatch_attempt, &sent_at);
    let bytes = match serde_json::to_vec(&body) {
        Ok(bytes) if bytes.len() <= MAX_BODY_BYTES => bytes,
        _ => return RuntimeAgentOutcome::Rejected,
    };
    let client = match reqwest::Client::builder().timeout(DEFAULT_TIMEOUT).build() {
        Ok(client) => client,
        Err(_) => return RuntimeAgentOutcome::Unknown,
    };
    let response = match timeout(
        DEFAULT_TIMEOUT,
        client
            .post(callback.url())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", token.as_ref()),
            )
            .body(bytes)
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(_)) | Err(_) => return RuntimeAgentOutcome::Unknown,
    };
    if !response.status().is_success() {
        return if response.status().is_client_error() {
            RuntimeAgentOutcome::Rejected
        } else {
            RuntimeAgentOutcome::Unknown
        };
    }
    let body = match timeout(DEFAULT_TIMEOUT, response.json::<Value>()).await {
        Ok(Ok(body)) => body,
        Ok(Err(_)) | Err(_) => return RuntimeAgentOutcome::Unknown,
    };
    response_outcome(&body, &request_id, agent_id, command.command_id())
}

fn response_outcome(
    body: &Value,
    request_id: &str,
    agent_id: &platform::endpoint::NativeAgentId,
    command_id: &fleet::command::CommandId,
) -> RuntimeAgentOutcome {
    if body.get("type").and_then(Value::as_str) != Some("runtime-agent.command.accept.response")
        || body.get("requestId").and_then(Value::as_str) != Some(request_id)
        || body.get("agentId").and_then(Value::as_str) != Some(agent_id.as_str())
    {
        return RuntimeAgentOutcome::Unknown;
    }

    match body.get("resultType").and_then(Value::as_str) {
        Some("accepted")
            if body.get("commandId").and_then(Value::as_str) == Some(command_id.as_str()) =>
        {
            RuntimeAgentOutcome::Accepted
        }
        Some("rejected")
            if body
                .get("commandId")
                .and_then(Value::as_str)
                .is_none_or(|value| value == command_id.as_str()) =>
        {
            RuntimeAgentOutcome::Rejected
        }
        _ => RuntimeAgentOutcome::Unknown,
    }
}

fn command_accept_envelope(
    request_id: &str,
    agent_id: &platform::endpoint::NativeAgentId,
    command: &fleet::command::CommandIntent,
    attempt: u64,
    sent_at: &str,
) -> Value {
    json!({
        "type": "runtime-agent.command.accept",
        "requestId": request_id,
        "agentId": agent_id.as_str(),
        "sentAt": sent_at,
        "commandId": command.command_id().as_str(),
        "commandName": command_name(command.kind()),
        "issuedAt": iso(command.queued_at()),
        "idempotencyKey": command.idempotency_key().as_str(),
        "commandAttempt": attempt,
        "dispatchAttempt": attempt,
        "payload": command_payload(command),
    })
}

fn command_payload(command: &fleet::command::CommandIntent) -> Value {
    let mut target = serde_json::Map::new();
    target.insert(
        "nodeId".to_owned(),
        Value::String(command.target().node_id().as_str().to_owned()),
    );
    if let Some(runtime_id) = command.target().runtime_id() {
        target.insert(
            "runtimeId".to_owned(),
            Value::String(runtime_id.as_str().to_owned()),
        );
    }
    if let Some(endpoint_id) = command.target().endpoint_id() {
        target.insert(
            "endpointId".to_owned(),
            Value::String(endpoint_id.as_str().to_owned()),
        );
    }

    let mut payload = serde_json::Map::new();
    payload.insert(
        "payloadType".to_owned(),
        Value::String("runtime-agent-command".to_owned()),
    );
    payload.insert(
        "commandId".to_owned(),
        Value::String(command.command_id().as_str().to_owned()),
    );
    payload.insert(
        "kind".to_owned(),
        Value::String(command_name(command.kind()).to_owned()),
    );
    payload.insert("target".to_owned(), Value::Object(target));
    Value::Object(payload)
}

fn iso(value: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(value).to_rfc3339()
}

fn command_name(kind: fleet::command::CommandKind) -> &'static str {
    match kind {
        fleet::command::CommandKind::ProbeNode => "probe-node",
        fleet::command::CommandKind::InstallAgent => "install-agent",
        fleet::command::CommandKind::StartRuntime => "start-runtime",
        fleet::command::CommandKind::StopRuntime => "stop-runtime",
        fleet::command::CommandKind::SyncCapabilities => "sync-capabilities",
        fleet::command::CommandKind::UpgradeAgent => "upgrade-agent",
        fleet::command::CommandKind::MountWorkspace => "mount-workspace",
        fleet::command::CommandKind::ExposePort => "expose-port",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_outcome_requires_full_correlation_and_preserves_unknown() {
        let id = platform::endpoint::NativeAgentId::try_new("agent-1").unwrap();
        let command = fleet::command::CommandId::try_new("command-1").unwrap();
        let accepted = json!({"type":"runtime-agent.command.accept.response","requestId":"r1","agentId":"agent-1","commandId":"command-1","resultType":"accepted"});
        assert_eq!(
            response_outcome(&accepted, "r1", &id, &command),
            RuntimeAgentOutcome::Accepted
        );
        assert_eq!(
            response_outcome(&accepted, "r2", &id, &command),
            RuntimeAgentOutcome::Unknown
        );
        assert_eq!(
            response_outcome(
                &json!({"type":"runtime-agent.command.accept.response","requestId":"r1","agentId":"agent-1","commandId":"other","resultType":"accepted"}),
                "r1",
                &id,
                &command
            ),
            RuntimeAgentOutcome::Unknown
        );
        assert_eq!(
            response_outcome(
                &json!({"type":"runtime-agent.command.accept.response","requestId":"r1","agentId":"agent-1","commandId":"command-1","resultType":"rejected"}),
                "r1",
                &id,
                &command
            ),
            RuntimeAgentOutcome::Rejected
        );
        assert!(!format!("{accepted:?}").contains("token"));
    }

    #[test]
    fn command_accept_envelope_preserves_history_shape_without_aliases_or_secrets() {
        let agent_id = platform::endpoint::NativeAgentId::try_new("agent-1").unwrap();
        let command = fleet::command::CommandIntent::new(
            fleet::command::CommandId::try_new("command-1").unwrap(),
            fleet::command::IdempotencyKey::try_new("idem-1").unwrap(),
            fleet::command::CommandTarget::Endpoint {
                node_id: fleet::topology::NodeId::try_new("node-1").unwrap(),
                runtime_id: fleet::topology::RuntimeId::try_new("runtime-1").unwrap(),
                endpoint_id: platform::endpoint::EndpointId::try_new("endpoint-1").unwrap(),
            },
            fleet::command::CommandKind::StartRuntime,
            std::time::SystemTime::UNIX_EPOCH,
        );

        let envelope = command_accept_envelope(
            "request-1",
            &agent_id,
            &command,
            7,
            "1970-01-01T00:00:10+00:00",
        );

        assert_eq!(
            envelope,
            json!({
                "type": "runtime-agent.command.accept",
                "requestId": "request-1",
                "agentId": "agent-1",
                "sentAt": "1970-01-01T00:00:10+00:00",
                "commandId": "command-1",
                "commandName": "start-runtime",
                "issuedAt": "1970-01-01T00:00:00+00:00",
                "idempotencyKey": "idem-1",
                "commandAttempt": 7,
                "dispatchAttempt": 7,
                "payload": {
                    "payloadType": "runtime-agent-command",
                    "commandId": "command-1",
                    "kind": "start-runtime",
                    "target": {
                        "nodeId": "node-1",
                        "runtimeId": "runtime-1",
                        "endpointId": "endpoint-1",
                    },
                },
            })
        );
        assert!(envelope.get("runtimeAgentCommand").is_none());
        assert!(envelope.get("data").is_none());
        assert!(!format!("{envelope:?}").contains("secret"));
    }
}
