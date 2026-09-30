use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{api::ChannelHandle, domain::operations::ChannelKey};
use platform::capability::CapabilityDecisionVerifier;

use super::{DecodeError, Delivery, decode};

pub async fn handle_login(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    endpoint: RuntimeEndpoint,
    cancellation: tokio_util::sync::CancellationToken,
) -> (u16, Value) {
    let trace_id = super::super::catalog::channel_trace_id(headers);
    platform::trace::with_channel_trace(trace_id, async {
        let mut span = crate::trace::ChannelTraceSpan::begin("channel.loopback.login");
        let response = async {
            if method != "POST" || path != "/api/channels/login" {
                return (
                    404,
                    serde_json::json!({
                        "success": false,
                        "error": "Channel login route is not available"
                    }),
                );
            }
            let authorization = headers
                .iter()
                .find(|(name, _)| name == "authorization")
                .and_then(|(_, value)| value.strip_prefix("Bearer "));
            let Some(authorization) = authorization else {
                return (
                    401,
                    serde_json::json!({
                        "success": false,
                        "error": "Channel login authorization is invalid"
                    }),
                );
            };
            let value = match serde_json::from_slice::<Value>(body) {
                Ok(value) => value,
                Err(error) => {
                    platform::trace::channel_trace(
                        "channel.loopback.json_decode",
                        match error.classify() {
                            serde_json::error::Category::Io => "outcome=io",
                            serde_json::error::Category::Syntax => "outcome=syntax",
                            serde_json::error::Category::Data => "outcome=data",
                            serde_json::error::Category::Eof => "outcome=eof",
                        },
                    );
                    return (400, serde_json::json!({"outcome": "rejected"}));
                }
            };
            let mut verifier = verifier.lock().await;
            let command = match decode(value, authorization, &mut verifier, now_millis()) {
                Ok(command) => command,
                Err(DecodeError::Unauthorized) => {
                    return (401, serde_json::json!({"outcome": "unknown"}));
                }
                Err(DecodeError::Invalid) => {
                    return (400, serde_json::json!({"outcome": "rejected"}));
                }
            };
            drop(verifier);
            platform::trace::channel_trace("channel.loopback.decode", "outcome=decoded");

            let mut call_id = None;
            let outcome = match command.action {
                crate::login::ChannelLoginAction::Start {
                    force,
                    timeout_ms,
                    account_id,
                    agent_id,
                    config,
                } => {
                    let key = match ChannelKey::try_new(
                        endpoint.clone(),
                        command.channel.clone(),
                        account_id.clone(),
                    ) {
                        Ok(key) => key,
                        Err(_) => return (400, serde_json::json!({"outcome": "rejected"})),
                    };
                    channel
                        .login_start(key, force, timeout_ms, agent_id, config)
                        .await
                        .map(|(outcome, id)| { call_id = id; outcome })
                        .map_err(|_| crate::login::Outcome::Unknown)
                }
                crate::login::ChannelLoginAction::Wait {
                    timeout_ms,
                    account_id,
                    session_key,
                    current_qr_data_url,
                } => {
                    let key = match ChannelKey::try_new(
                        endpoint.clone(),
                        command.channel.clone(),
                        account_id.clone(),
                    ) {
                        Ok(key) => key,
                        Err(_) => return (400, serde_json::json!({"outcome": "rejected"})),
                    };
                    channel
                        .login_wait(
                            key,
                            timeout_ms,
                            session_key,
                            current_qr_data_url,
                            cancellation,
                        )
                        .await
                        .map(|(outcome, id)| { call_id = id; outcome })
                        .map_err(|_| crate::login::Outcome::Unknown)
                }
                crate::login::ChannelLoginAction::Logout { account_id } => {
                    let key = match ChannelKey::try_new(
                        endpoint.clone(),
                        command.channel.clone(),
                        account_id.clone(),
                    ) {
                        Ok(key) => key,
                        Err(_) => return (400, serde_json::json!({"outcome": "rejected"})),
                    };
                    return match channel.logout(key).await {
                        Ok(receipt) => (202, serde_json::json!(receipt)),
                        Err(_) => (503, serde_json::json!({"outcome": "unknown"})),
                    };
                }
                crate::login::ChannelLoginAction::Cancel { account_id } => {
                    let key = match ChannelKey::try_new(
                        endpoint.clone(),
                        command.channel.clone(),
                        account_id.clone(),
                    ) {
                        Ok(key) => key,
                        Err(_) => return (400, serde_json::json!({"outcome": "rejected"})),
                    };
                    channel
                        .cancel_login(key)
                        .await
                        .map_err(|_| crate::login::Outcome::Unknown)
                }
            }
            .unwrap_or(crate::login::Outcome::Unknown);

            let delivery = match outcome {
                crate::login::Outcome::Progress(progress) => Delivery::Progress(progress),
                crate::login::Outcome::Confirmed => Delivery::Confirmed,
                crate::login::Outcome::Cancelled => Delivery::Cancelled,
                crate::login::Outcome::Rejected | crate::login::Outcome::Unsupported => {
                    Delivery::Rejected
                }
                crate::login::Outcome::Unknown => Delivery::Unknown,
            };
            let mut body = delivery.body();
            if body.get("channel").is_some() {
                if let Some(call_id) = call_id {
                    body["callId"] = serde_json::json!(call_id);
                }
            }
            (delivery.status_code(), body)
        }
        .await;
        span.finish(match response.0 {
            202 => "accepted",
            200 => "delivered",
            400 => "invalid",
            401 => "unauthorized",
            404 => "not_found",
            _ => "unavailable",
        });
        response
    })
    .await
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
