use std::{fmt, sync::Arc};

use serde_json::{Map, Value};

use crate::gateway::{
    client::GatewayClient,
    delivery::MutationDelivery,
    operation::next_request_id,
    wire::{self, GatewayResponse},
};

const SECURITY_EMERGENCY_RUN_METHOD: &str = "security.emergency.run";
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Narrow native edge for the fixed `security.emergency.run` mutation.
///
/// It retains only the authenticated Gateway client and returns an opaque
/// receipt. Gateway payload, policy, configuration, and evidence stay inside
/// this integration.
pub struct SecurityEmergencyOperation {
    gateway: Arc<GatewayClient>,
}

impl SecurityEmergencyOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn run(&self) -> SecurityEmergencyEffect {
        run_security_emergency(&self.gateway).await
    }
}

impl fmt::Debug for SecurityEmergencyOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecurityEmergencyOperation")
            .finish_non_exhaustive()
    }
}

async fn run_security_emergency(gateway: &GatewayClient) -> SecurityEmergencyEffect {
    let request = match security_emergency_run_request(next_request_id("security-emergency")) {
        Ok(request) => request,
        Err(_) => return SecurityEmergencyEffect::OutcomeUnknown,
    };
    match gateway.rpc_mutation(request).await {
        MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
            SecurityEmergencyEffect::RuntimeRejected
        }
        MutationDelivery::Response(response) => match decode_security_emergency(response) {
            Ok(receipt) => SecurityEmergencyEffect::Applied(receipt),
            Err(_) => SecurityEmergencyEffect::OutcomeUnknown,
        },
        MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
            SecurityEmergencyEffect::OutcomeUnknown
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SecurityEmergencyReceipt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityEmergencyEffect {
    Applied(SecurityEmergencyReceipt),
    RuntimeRejected,
    OutcomeUnknown,
}

fn security_emergency_run_request(request_id: String) -> Result<wire::RpcRequest, wire::WireError> {
    wire::operations_request(
        request_id,
        SECURITY_EMERGENCY_RUN_METHOD,
        Value::Object(Map::new()),
    )
}

fn decode_security_emergency(response: GatewayResponse) -> Result<SecurityEmergencyReceipt, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(
        &payload,
        &[
            "backend",
            "lockdownApplied",
            "lockdown",
            "incidentId",
            "appliedAt",
            "evidenceDir",
            "reportPath",
            "runtimeSnapshotPath",
            "recentChanges",
            "recommendations",
            "skippedChecks",
        ],
    )?;
    if payload.get("backend").and_then(Value::as_str) != Some("security-core")
        || payload.get("lockdownApplied").and_then(Value::as_bool) != Some(true)
        || !required_non_empty_string(&payload, "incidentId")
        || required_u64(&payload, "appliedAt")? == 0
        || !required_non_empty_string(&payload, "evidenceDir")
        || !required_non_empty_string(&payload, "reportPath")
        || !required_non_empty_string(&payload, "runtimeSnapshotPath")
    {
        return Err(());
    }
    for field in ["recentChanges", "recommendations", "skippedChecks"] {
        if !required_array(&payload, field)?
            .iter()
            .all(|item| item.as_str().is_some_and(|value| !value.is_empty()))
        {
            return Err(());
        }
    }
    let lockdown = required_object(&payload, "lockdown")?;
    require_exact_fields(
        lockdown,
        &[
            "preset",
            "blockDestructive",
            "blockSecrets",
            "runtimeGuardEnabled",
            "enablePromptInjectionGuard",
            "allowlistedTools",
            "allowlistedSessions",
            "allowDomains",
        ],
    )?;
    if lockdown.get("preset").and_then(Value::as_str) != Some("strict")
        || lockdown.get("blockDestructive").and_then(Value::as_bool) != Some(true)
        || lockdown.get("blockSecrets").and_then(Value::as_bool) != Some(true)
        || lockdown.get("runtimeGuardEnabled").and_then(Value::as_bool) != Some(true)
        || lockdown
            .get("enablePromptInjectionGuard")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(());
    }
    for field in ["allowlistedTools", "allowlistedSessions", "allowDomains"] {
        required_u64(lockdown, field)?;
    }
    Ok(SecurityEmergencyReceipt)
}

fn success_payload_object(response: GatewayResponse) -> Result<Map<String, Value>, ()> {
    match response {
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } => Ok(payload),
        GatewayResponse::Failure { .. } | GatewayResponse::Success { .. } => Err(()),
    }
}

fn require_exact_fields(payload: &Map<String, Value>, expected: &[&str]) -> Result<(), ()> {
    if payload.len() != expected.len() {
        return Err(());
    }
    reject_unknown_fields(payload, expected)
}

fn reject_unknown_fields(payload: &Map<String, Value>, expected: &[&str]) -> Result<(), ()> {
    if payload
        .keys()
        .any(|field| !expected.contains(&field.as_str()))
    {
        return Err(());
    }
    Ok(())
}

fn required_object<'a>(
    payload: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Map<String, Value>, ()> {
    payload.get(field).and_then(Value::as_object).ok_or(())
}

fn required_array<'a>(payload: &'a Map<String, Value>, field: &str) -> Result<&'a [Value], ()> {
    payload
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or(())
}

fn required_u64(payload: &Map<String, Value>, field: &str) -> Result<u64, ()> {
    payload
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
        .ok_or(())
}

fn required_non_empty_string(payload: &Map<String, Value>, field: &str) -> bool {
    payload
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::{Error as WebSocketError, Message, error::ProtocolError};

    use super::*;
    use crate::gateway::{
        auth::GatewaySecret,
        client::{GatewayClientMetadata, GatewayEndpoint, test_support::*},
        wire,
    };

    #[tokio::test(flavor = "current_thread")]
    async fn security_emergency_requires_a_complete_lockdown_receipt_without_projection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket, SECURITY_EMERGENCY_RUN_METHOD).await;
            let request = read_json(&mut socket).await;
            assert_eq!(request["method"], SECURITY_EMERGENCY_RUN_METHOD);
            assert_eq!(request["params"], json!({}));
            let request_id = request["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": request_id, "ok": true,
                    "payload": security_emergency_payload()
                }),
            )
            .await;
            assert_connection_closed(&mut socket).await;
        });

        let effect = SecurityEmergencyOperation::new(Arc::new(client))
            .run()
            .await;
        server.await.unwrap();

        assert_eq!(
            effect,
            SecurityEmergencyEffect::Applied(SecurityEmergencyReceipt)
        );
        assert!(!format!("{effect:?}").contains("private-canary"));
    }

    #[test]
    fn security_emergency_decoder_rejects_unknown_or_incomplete_results_without_exposing_them() {
        let canary = "private-canary";
        let mut missing_lockdown = security_emergency_payload();
        missing_lockdown.as_object_mut().unwrap().remove("lockdown");
        let mut non_strict = security_emergency_payload();
        non_strict["lockdown"]["preset"] = json!("balanced");
        let mut unexpected = security_emergency_payload();
        unexpected["unexpected"] = json!(canary);

        for payload in [missing_lockdown, non_strict, unexpected] {
            let effect = decode_security_emergency(success_response(payload));
            assert!(effect.is_err());
            assert!(!format!("{effect:?}").contains(canary));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn security_emergency_rejection_and_transport_ambiguity_do_not_claim_lockdown() {
        for response in [
            json!({
                "type": "res", "ok": false,
                "error": {
                    "code": "denied", "message": "access denied", "details": null,
                    "retryable": false, "retryAfterMs": null
                }
            }),
            json!({
                "type": "res", "ok": true,
                "payload": {"backend": "security-core", "lockdownApplied": true}
            }),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let identity = TestTlsIdentity::generate();
            let client = test_client(&listener, identity.fingerprint());
            let acceptor = identity.acceptor();
            let server = tokio::spawn(async move {
                let mut socket = accept_websocket(&listener, &acceptor).await;
                serve_hello(&mut socket, SECURITY_EMERGENCY_RUN_METHOD).await;
                let request = read_json(&mut socket).await;
                let request_id = request["id"].as_str().unwrap();
                let mut response = response;
                response["id"] = json!(request_id);
                send_json(&mut socket, response).await;
                assert_connection_closed(&mut socket).await;
            });

            let effect = SecurityEmergencyOperation::new(Arc::new(client))
                .run()
                .await;
            server.await.unwrap();

            assert!(matches!(
                effect,
                SecurityEmergencyEffect::RuntimeRejected | SecurityEmergencyEffect::OutcomeUnknown
            ));
        }
    }

    fn success_response(payload: Value) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: "test-request".into(),
            payload: Some(payload),
        }
    }

    fn security_emergency_payload() -> Value {
        json!({
            "backend": "security-core",
            "lockdownApplied": true,
            "lockdown": {
                "preset": "strict",
                "blockDestructive": true,
                "blockSecrets": true,
                "runtimeGuardEnabled": true,
                "enablePromptInjectionGuard": true,
                "allowlistedTools": 0,
                "allowlistedSessions": 0,
                "allowDomains": 0
            },
            "incidentId": "incident-1",
            "appliedAt": 42,
            "evidenceDir": "private-canary/evidence",
            "reportPath": "private-canary/report",
            "runtimeSnapshotPath": "private-canary/snapshot",
            "recentChanges": ["private-canary/change"],
            "recommendations": ["private-canary/recommendation"],
            "skippedChecks": ["private-canary/check"]
        })
    }

    fn test_client(
        listener: &TcpListener,
        certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
    ) -> GatewayClient {
        GatewayClient::new(
            GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
            certificate_fingerprint,
            Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
            GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
        )
    }

    async fn serve_hello(socket: &mut TestSocket, method: &str) {
        serve_hello_with_capability(socket, wire::OPENCLAW_GATEWAY_VERSION, vec![method]).await;
    }

    async fn serve_hello_with_capability(
        socket: &mut TestSocket,
        version: &str,
        methods: Vec<&str>,
    ) {
        send_json(
            socket,
            json!({
                "type": "event", "event": "connect.challenge",
                "payload": {"nonce": "fake-nonce", "ts": 42}
            }),
        )
        .await;
        let connect = read_json(socket).await;
        assert_eq!(connect["method"], "connect");
        let request_id = connect["id"].as_str().unwrap();
        send_json(
            socket,
            json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {
                    "type": "hello-ok", "protocol": 4,
                    "server": {"version": version, "connId": "fixture"},
                    "features": {"methods": methods, "events": ["tick"]},
                    "snapshot": {
                        "presence": [], "health": {"ok": true},
                        "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 1
                    },
                    "auth": {"role": "operator", "scopes": ["operator.read", "operator.write", "operator.admin", "operator.approvals"]},
                    "policy": {"maxPayload": 26214400, "maxBufferedBytes": 52428800, "tickIntervalMs": 15000}
                }
            }),
        )
        .await;
    }

    async fn read_json(socket: &mut TestSocket) -> Value {
        let message = socket.next().await.unwrap().unwrap();
        let text = message.into_text().unwrap();
        serde_json::from_str(&text).unwrap()
    }

    async fn send_json(socket: &mut TestSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    async fn assert_connection_closed(socket: &mut TestSocket) {
        match socket.next().await {
            Some(Ok(Message::Close(_))) | None => {}
            Some(Err(WebSocketError::Protocol(ProtocolError::ResetWithoutClosingHandshake))) => {}
            other => panic!("expected closed connection, got {other:?}"),
        }
    }
}
