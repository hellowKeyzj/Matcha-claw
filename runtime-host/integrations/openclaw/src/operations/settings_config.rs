use std::sync::Arc;

use serde_json::Value;
use zeroize::Zeroize;

use crate::{
    gateway::{
        client::GatewayClient,
        delivery::MutationDelivery,
        wire::{self, GatewayResponse},
    },
    projection::{config_store::OpenClawConfigDocument, settings::SettingsProjection},
};

use super::{OperationsReadError, next_request_id, read_gateway};

pub struct SettingsConfigOperation {
    gateway: Arc<GatewayClient>,
}

impl SettingsConfigOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn apply(&self, projection: &SettingsProjection) -> SettingsConfigMutationOutcome {
        let get = match wire::team::config_get_request(next_request_id("settings-config-get")) {
            Ok(request) => request,
            Err(_) => return SettingsConfigMutationOutcome::Unknown,
        };
        let snapshot = match read_gateway(&self.gateway, get).await {
            Ok(GatewayResponse::Failure { .. }) => return SettingsConfigMutationOutcome::Rejected,
            Ok(response) => match wire::team::decode_config_get(response) {
                Ok(snapshot) => snapshot,
                Err(_) => return SettingsConfigMutationOutcome::Unknown,
            },
            Err(OperationsReadError::Rejected) => return SettingsConfigMutationOutcome::Rejected,
            Err(_) => return SettingsConfigMutationOutcome::Unknown,
        };
        let (document, base_hash) = snapshot.into_source_config_parts();
        let current = match OpenClawConfigDocument::from_value(document) {
            Ok(document) => document,
            Err(_) => return SettingsConfigMutationOutcome::Unknown,
        };
        let mut patch = projection.build_config_patch(&current);
        if !patch.changed {
            return SettingsConfigMutationOutcome::Noop;
        }
        let serialized = serde_json::to_string(&patch.patch);
        zeroize_value(&mut patch.patch);
        let raw = match serialized {
            Ok(raw) if !raw.is_empty() => raw,
            _ => return SettingsConfigMutationOutcome::Unknown,
        };
        let document = match wire::team::ConfigDocument::new(raw) {
            Ok(document) => document,
            Err(_) => return SettingsConfigMutationOutcome::Unknown,
        };
        let request = match wire::team::config_patch_request(
            next_request_id("settings-config-patch"),
            document,
            base_hash,
            patch.replace_paths,
        ) {
            Ok(request) => request,
            Err(_) => return SettingsConfigMutationOutcome::Unknown,
        };
        match self
            .gateway
            .rpc_encoded_mutation(
                request.request_id().to_owned(),
                match request.encode() {
                    Ok(encoded) => encoded,
                    Err(_) => return SettingsConfigMutationOutcome::Unknown,
                },
            )
            .await
        {
            MutationDelivery::Response(GatewayResponse::Failure { error, .. }) => {
                if wire::channel::is_config_restart_required(&error) {
                    SettingsConfigMutationOutcome::RestartRequired
                } else {
                    SettingsConfigMutationOutcome::Rejected
                }
            }
            MutationDelivery::Response(response) => {
                match wire::channel::decode_channel_config_patch(response) {
                    Ok(wire::channel::ChannelConfigPatchOutcome::Written) => {
                        SettingsConfigMutationOutcome::Confirmed
                    }
                    Ok(wire::channel::ChannelConfigPatchOutcome::Noop) => {
                        SettingsConfigMutationOutcome::Noop
                    }
                    Ok(wire::channel::ChannelConfigPatchOutcome::RestartRequired) => {
                        SettingsConfigMutationOutcome::RestartRequired
                    }
                    Err(_) => SettingsConfigMutationOutcome::Unknown,
                }
            }
            MutationDelivery::NotWritten(_) => SettingsConfigMutationOutcome::Rejected,
            MutationDelivery::MayHaveReached(_) => SettingsConfigMutationOutcome::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsConfigMutationOutcome {
    Confirmed,
    Noop,
    RestartRequired,
    Rejected,
    Unknown,
}

fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(values) => values.values_mut().for_each(zeroize_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::{net::TcpListener, time::timeout};
    use tokio_tungstenite::tungstenite::Message;

    use super::*;
    use crate::{
        gateway::{
            auth::GatewaySecret,
            client::{
                GatewayClientMetadata, GatewayEndpoint,
                test_support::{TestSocket, TestTlsIdentity, accept_websocket},
            },
        },
        projection::settings::BrowserMode,
    };

    const BROWSER_RELAY_PLUGIN: &str = "browser-relay";

    #[tokio::test(flavor = "current_thread")]
    async fn unchanged_projection_returns_noop_without_config_patch() {
        let (outcome, write) = run_settings_operation(matching_native_config(), None).await;

        assert_eq!(outcome, SettingsConfigMutationOutcome::Noop);
        assert_eq!(write, None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn written_config_patch_response_confirms_settings_mutation() {
        let (outcome, write) =
            run_settings_operation(config_needing_native_patch(), Some(PatchReply::Written)).await;

        assert_eq!(outcome, SettingsConfigMutationOutcome::Confirmed);
        assert_native_patch(write.unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn patch_uses_source_config_not_runtime_overlay() {
        let source = config_needing_native_patch();
        let mut runtime = source.clone();
        runtime["plugins"]["allow"] = json!(["other", BROWSER_RELAY_PLUGIN, "runtime-only"]);
        runtime["plugins"]["entries"]["runtime-only"] = json!({"enabled": true});

        let (outcome, write) =
            run_settings_operation_with_runtime(source, runtime, Some(PatchReply::Written)).await;

        assert_eq!(outcome, SettingsConfigMutationOutcome::Confirmed);
        assert_native_patch(write.unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn noop_config_patch_response_reports_noop() {
        let (outcome, write) =
            run_settings_operation(config_needing_native_patch(), Some(PatchReply::Noop)).await;

        assert_eq!(outcome, SettingsConfigMutationOutcome::Noop);
        assert_native_patch(write.unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restart_required_config_patch_response_requests_restart() {
        let (outcome, write) = run_settings_operation(
            config_needing_native_patch(),
            Some(PatchReply::RestartRequired),
        )
        .await;

        assert_eq!(outcome, SettingsConfigMutationOutcome::RestartRequired);
        assert_native_patch(write.unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejected_config_patch_response_reports_rejected() {
        let (outcome, write) =
            run_settings_operation(config_needing_native_patch(), Some(PatchReply::Rejected)).await;

        assert_eq!(outcome, SettingsConfigMutationOutcome::Rejected);
        assert_native_patch(write.unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invalid_config_patch_response_reports_unknown() {
        let (outcome, write) =
            run_settings_operation(config_needing_native_patch(), Some(PatchReply::Invalid)).await;

        assert_eq!(outcome, SettingsConfigMutationOutcome::Unknown);
        assert_native_patch(write.unwrap());
    }

    #[derive(Clone, Copy)]
    enum PatchReply {
        Written,
        Noop,
        RestartRequired,
        Rejected,
        Invalid,
    }

    async fn run_settings_operation(
        current: Value,
        patch_reply: Option<PatchReply>,
    ) -> (SettingsConfigMutationOutcome, Option<Value>) {
        run_settings_operation_with_runtime(current.clone(), current, patch_reply).await
    }

    async fn run_settings_operation_with_runtime(
        source: Value,
        runtime: Value,
        patch_reply: Option<PatchReply>,
    ) -> (SettingsConfigMutationOutcome, Option<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let read = read_json(&mut socket).await;
            assert_eq!(read["method"], "config.get");
            let read_id = read["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": read_id, "ok": true,
                    "payload": config_snapshot(source, runtime, "hash-1")
                }),
            )
            .await;
            match patch_reply {
                Some(reply) => {
                    let write = read_json(&mut socket).await;
                    assert_eq!(write["method"], "config.patch");
                    let write_id = write["id"].as_str().unwrap();
                    send_json(&mut socket, patch_response(write_id, reply)).await;
                    Some(write)
                }
                None => {
                    assert_no_config_patch(&mut socket).await;
                    None
                }
            }
        });
        let projection =
            SettingsProjection::try_new(BrowserMode::Native, Some("proxy.internal:8080")).unwrap();

        let outcome = SettingsConfigOperation::new(Arc::new(client))
            .apply(&projection)
            .await;
        let write = server.await.unwrap();
        (outcome, write)
    }

    fn matching_native_config() -> Value {
        json!({
            "browser": {
                "enabled": true,
                "defaultProfile": "openclaw"
            },
            "plugins": {
                "allow": ["other"],
                "entries": {
                    BROWSER_RELAY_PLUGIN: { "enabled": false, "custom": true }
                }
            },
            "proxy": {
                "enabled": true,
                "proxyUrl": "http://proxy.internal:8080",
                "loopbackMode": "gateway-only"
            },
            "channels": {
                "telegram": {
                    "defaultAccount": "work",
                    "accounts": {
                        "work": {
                            "proxy": "http://channel.proxy:8080",
                            "label": "preserve"
                        }
                    }
                }
            }
        })
    }

    fn config_needing_native_patch() -> Value {
        json!({
            "browser": {
                "enabled": false,
                "profiles": { "custom": { "color": "#123456" } }
            },
            "plugins": {
                "allow": ["other", BROWSER_RELAY_PLUGIN],
                "entries": {
                    BROWSER_RELAY_PLUGIN: { "enabled": true, "custom": true }
                }
            },
            "channels": {
                "telegram": {
                    "defaultAccount": "work",
                    "accounts": {
                        "work": { "label": "preserve" }
                    }
                }
            }
        })
    }

    fn config_snapshot(source: Value, runtime: Value, hash: &str) -> Value {
        let raw = source.to_string();
        json!({
            "path": "openclaw.json",
            "exists": true,
            "raw": raw,
            "parsed": source.clone(),
            "sourceConfig": source,
            "resolved": runtime.clone(),
            "valid": true,
            "runtimeConfig": runtime.clone(),
            "config": runtime,
            "hash": hash,
            "issues": [],
            "warnings": [],
            "legacyIssues": []
        })
    }

    fn patch_response(request_id: &str, reply: PatchReply) -> Value {
        match reply {
            PatchReply::Written => json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {"ok": true}
            }),
            PatchReply::Noop => json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {"ok": true, "noop": true}
            }),
            PatchReply::RestartRequired => json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {
                    "ok": true,
                    "sentinel": {"payload": {"stats": {"requiresRestart": true}}}
                }
            }),
            PatchReply::Rejected => json!({
                "type": "res", "id": request_id, "ok": false,
                "error": {"code": "INVALID_REQUEST", "message": "rejected"}
            }),
            PatchReply::Invalid => json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {"unexpected": true}
            }),
        }
    }

    fn assert_native_patch(write: Value) {
        assert_eq!(write["params"]["baseHash"], json!("hash-1"));
        assert_eq!(write["params"]["replacePaths"], json!(["plugins.allow"]));
        let raw = write["params"]["raw"].as_str().unwrap();
        let patch: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(patch["browser"]["enabled"], true);
        assert_eq!(patch["browser"]["defaultProfile"], "openclaw");
        assert_eq!(patch["plugins"]["allow"], json!(["other"]));
        assert_eq!(
            patch["plugins"]["entries"][BROWSER_RELAY_PLUGIN]["enabled"],
            false
        );
        assert_eq!(patch["proxy"]["enabled"], true);
        assert_eq!(patch["proxy"]["proxyUrl"], "http://proxy.internal:8080");
        assert_eq!(patch["proxy"]["loopbackMode"], "gateway-only");
        assert!(patch.get("channels").is_none());
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
        let request_id = connect["id"].as_str().unwrap();
        send_json(
            socket,
            json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {
                    "type": "hello-ok", "protocol": 4,
                    "server": {"version": wire::OPENCLAW_GATEWAY_VERSION, "connId": "fixture"},
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
                            wire::SYSTEM_PRESENCE_METHOD
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

    async fn assert_no_config_patch(socket: &mut TestSocket) {
        match timeout(Duration::from_millis(50), socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_ne!(value["method"], "config.patch");
            }
            Ok(_) | Err(_) => {}
        }
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
