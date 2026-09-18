use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    channel::{ChannelHandle, ChannelKey},
    transport::common::authorization::CapabilityDecisionVerifier,
};

use super::{DecodeError, Delivery, decode};

pub(crate) async fn handle_login(
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
    openclaw::operations::channel_config::with_channel_trace(trace_id, async {
        let mut span = crate::channel::trace::ChannelTraceSpan::begin("host.transport.login");
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
                    openclaw::operations::channel_config::channel_trace(
                        "host.transport.json_decode",
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
            openclaw::operations::channel_config::channel_trace(
                "host.transport.decode",
                "outcome=decoded",
            );

            let outcome = match command.action {
                crate::channel::login::ChannelLoginAction::Start {
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
                        .map_err(|_| crate::channel::login::Outcome::Unknown)
                }
                crate::channel::login::ChannelLoginAction::Wait {
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
                        .map_err(|_| crate::channel::login::Outcome::Unknown)
                }
                crate::channel::login::ChannelLoginAction::Logout { account_id } => {
                    let key = match ChannelKey::try_new(
                        endpoint.clone(),
                        command.channel.clone(),
                        account_id.clone(),
                    ) {
                        Ok(key) => key,
                        Err(_) => return (400, serde_json::json!({"outcome": "rejected"})),
                    };
                    channel
                        .logout(key)
                        .await
                        .map_err(|_| crate::channel::login::Outcome::Unknown)
                }
                crate::channel::login::ChannelLoginAction::Cancel { account_id } => {
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
                        .map_err(|_| crate::channel::login::Outcome::Unknown)
                }
            }
            .unwrap_or(crate::channel::login::Outcome::Unknown);

            let delivery = match outcome {
                crate::channel::login::Outcome::Progress(progress) => Delivery::Progress(progress),
                crate::channel::login::Outcome::Confirmed => Delivery::Confirmed,
                crate::channel::login::Outcome::Cancelled => Delivery::Cancelled,
                crate::channel::login::Outcome::Rejected
                | crate::channel::login::Outcome::Unsupported => Delivery::Rejected,
                crate::channel::login::Outcome::Unknown => Delivery::Unknown,
            };
            (delivery.status_code(), delivery.body())
        }
        .await;
        span.finish(match response.0 {
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
