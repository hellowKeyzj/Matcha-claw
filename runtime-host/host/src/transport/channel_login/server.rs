use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::transport::authorization::CapabilityDecisionVerifier;

use super::{DecodeError, Delivery, decode};

pub(crate) async fn handle_login(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
    cancellation: tokio_util::sync::CancellationToken,
) -> (u16, Value) {
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
        Err(_) => {
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

    let outcome = match command.action {
        crate::channel_login::ChannelLoginAction::Start {
            force,
            timeout_ms,
            account_id,
            config,
        } => owner
            .start_channel_login(command.channel, force, timeout_ms, account_id, config)
            .await
            .map_err(|_| crate::channel_login::Outcome::Unknown),
        crate::channel_login::ChannelLoginAction::Wait {
            timeout_ms,
            account_id,
            session_key,
            current_qr_data_url,
        } => owner
            .wait_channel_login(
                command.channel,
                timeout_ms,
                account_id,
                session_key,
                current_qr_data_url,
                cancellation,
            )
            .await
            .map_err(|_| crate::channel_login::Outcome::Unknown),
        crate::channel_login::ChannelLoginAction::Logout { account_id } => owner
            .logout_channel(command.channel, account_id)
            .await
            .map_err(|_| crate::channel_login::Outcome::Unknown),
        crate::channel_login::ChannelLoginAction::Cancel { account_id } => owner
            .cancel_channel_login(command.channel, account_id)
            .await
            .map_err(|_| crate::channel_login::Outcome::Unknown),
    }
    .unwrap_or(crate::channel_login::Outcome::Unknown);

    let delivery = match outcome {
        crate::channel_login::Outcome::Progress(progress) => Delivery::Progress(progress),
        crate::channel_login::Outcome::Confirmed => Delivery::Confirmed,
        crate::channel_login::Outcome::Cancelled => Delivery::Cancelled,
        crate::channel_login::Outcome::Rejected | crate::channel_login::Outcome::Unsupported => {
            Delivery::Rejected
        }
        crate::channel_login::Outcome::Unknown => Delivery::Unknown,
    };
    (delivery.status_code(), delivery.body())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
