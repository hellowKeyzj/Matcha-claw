use std::sync::Arc;

use serde_json::{Map, Value};

use crate::gateway::{
    client::GatewayClient,
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

use super::next_request_id;

const PLUGINS_REFRESH_METHOD: &str = "plugins.refresh";

pub struct PluginRefreshOperation {
    gateway: Arc<GatewayClient>,
}

impl PluginRefreshOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn refresh(&self) -> PluginRefreshOutcome {
        refresh_plugins(&self.gateway).await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginRefreshOutcome {
    RestartRequired,
    Rejected,
    Unknown,
}

async fn refresh_plugins(gateway: &GatewayClient) -> PluginRefreshOutcome {
    let request = match plugins_refresh_request(next_request_id("plugins-refresh")) {
        Ok(request) => request,
        Err(_) => return PluginRefreshOutcome::Unknown,
    };
    match gateway.rpc_mutation(request).await {
        MutationDelivery::Response(GatewayResponse::Failure { error, .. }) => {
            if error.restart_required() {
                PluginRefreshOutcome::RestartRequired
            } else {
                PluginRefreshOutcome::Rejected
            }
        }
        MutationDelivery::Response(response) => decode_plugins_refresh(response)
            .map(|()| PluginRefreshOutcome::RestartRequired)
            .unwrap_or(PluginRefreshOutcome::Unknown),
        MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
            PluginRefreshOutcome::Unknown
        }
    }
}

fn plugins_refresh_request(request_id: String) -> Result<wire::RpcRequest, wire::WireError> {
    wire::operations_request(
        request_id,
        PLUGINS_REFRESH_METHOD,
        Value::Object(Map::new()),
    )
}

fn decode_plugins_refresh(response: GatewayResponse) -> Result<(), ()> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(payload)),
        ..
    } = response
    else {
        return Err(());
    };
    if payload.get("ok").and_then(Value::as_bool) == Some(true)
        && payload.get("restartRequired").and_then(Value::as_bool) == Some(true)
    {
        Ok(())
    } else {
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    use super::*;
    use crate::gateway::{
        auth::GatewaySecret,
        client::{GatewayClientMetadata, GatewayEndpoint, test_support::*},
    };

    #[tokio::test(flavor = "current_thread")]
    async fn refresh_maps_success_and_restart_required_failure() {
        for response in [
            json!({"type":"res","ok":true,"payload":{"ok":true,"restartRequired":true}}),
            json!({"type":"res","ok":false,"error":{"code":"UNAVAILABLE","message":"Plugin inventory refresh failed. Restart the Gateway to load updated plugins.","details":{"restartRequired":true}}}),
        ] {
            assert_eq!(
                run_refresh_response(response).await,
                PluginRefreshOutcome::RestartRequired
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refresh_does_not_turn_bad_receipts_into_restart() {
        for response in [
            json!({"type":"res","ok":true,"payload":{"ok":true,"restartRequired":false}}),
            json!({"type":"res","ok":false,"error":{"code":"INVALID_REQUEST","message":"bad request"}}),
        ] {
            assert!(matches!(
                run_refresh_response(response).await,
                PluginRefreshOutcome::Unknown | PluginRefreshOutcome::Rejected
            ));
        }
    }

    async fn run_refresh_response(mut response: Value) -> PluginRefreshOutcome {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let request = read_json(&mut socket).await;
            assert_eq!(request["method"], PLUGINS_REFRESH_METHOD);
            assert_eq!(request["params"], json!({}));
            response["id"] = request["id"].clone();
            send_json(&mut socket, response).await;
        });
        let outcome = PluginRefreshOperation::new(Arc::new(client))
            .refresh()
            .await;
        server.await.unwrap();
        outcome
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

    async fn serve_hello(socket: &mut TestSocket) {
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
        send_json(
            socket,
            json!({
                "type": "res", "id": connect["id"], "ok": true,
                "payload": {
                    "type": "hello-ok", "protocol": 4,
                    "server": {"version": crate::gateway::wire::OPENCLAW_GATEWAY_VERSION, "connId": "fixture"},
                    "features": {
                        "methods": [
                            "status",
                            "config.get",
                            "config.patch",
                            "config.apply",
                            "plugins.refresh",
                            "agents.list",
                            "skills.status",
                            "channels.pairing.list",
                            "sessions.describe",
                            crate::gateway::wire::SYSTEM_PRESENCE_METHOD
                        ],
                        "events": ["tick"]
                    },
                    "snapshot": {
                        "presence": [], "health": {"ok": true},
                        "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 1
                    },
                    "auth": {
                        "role": "operator",
                        "scopes": ["operator.read", "operator.write", "operator.admin", "operator.approvals"]
                    },
                    "policy": {
                        "maxPayload": 26214400, "maxBufferedBytes": 52428800,
                        "tickIntervalMs": 15000
                    }
                }
            }),
        )
        .await;
    }

    async fn read_json(socket: &mut TestSocket) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected text frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn send_json(socket: &mut TestSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }
}
