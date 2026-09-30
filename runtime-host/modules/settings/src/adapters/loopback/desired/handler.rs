use platform::{
    call::{CallContext, CallRecorder, CallStatus},
    capability::CapabilityDecisionVerifier,
};

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    application::call::{SettingsCallDetail, SettingsCallFailure, SettingsOperation},
    domain::{BrowserMode, Desired, ProxyDesired},
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::{DecodeError, ENDPOINT, READ_ENDPOINT, decode};

use platform::loopback;

use crate::api::SettingsHandle;

pub(crate) async fn handle_route(
    method: &str,
    path: &str,
    authorization: Option<&str>,
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    settings_handle: SettingsHandle,
    call_recorder: Option<CallRecorder>,
) -> loopback::Response {
    let operation = match (method, path) {
        ("GET", READ_ENDPOINT) => SettingsOperation::ReadCurrent,
        ("POST", ENDPOINT) => SettingsOperation::ReplaceDesired,
        _ => return Response::not_found().into(),
    };
    let Some(recorder) = call_recorder else {
        return Response::unavailable().into();
    };
    let detail = SettingsCallDetail::new(operation);
    let command = match operation {
        SettingsOperation::ReadCurrent => "settings.current",
        SettingsOperation::ReplaceDesired => "settings.replace",
    };
    let call = match recorder.begin(command, &detail).await {
        Ok(call) => call,
        Err(_) => return Response::unavailable().into(),
    };
    let response = handle_request(
        method,
        path,
        authorization,
        body,
        verifier,
        settings_handle,
        call.clone(),
    )
    .await;
    if !matches!(response.status, 400 | 401) {
        return response.into();
    }
    let mut detail = detail;
    detail.failure = Some(if response.status == 401 {
        SettingsCallFailure::Unauthorized
    } else {
        SettingsCallFailure::InvalidRequest
    });
    if call.finish(CallStatus::Rejected, &detail).await.is_err() {
        return Response::unavailable().into();
    }
    response.into()
}

async fn handle_request(
    method: &str,
    path: &str,
    authorization: Option<&str>,
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    settings_handle: SettingsHandle,
    call: CallContext<SettingsCallDetail>,
) -> Response {
    if method == "GET" && path == READ_ENDPOINT {
        return match settings_handle.desired_snapshot(call).await {
            Ok(snapshot) => Response::ok(snapshot.to_json()),
            Err(_) => Response::unavailable(),
        };
    }
    if method != "POST" || path != ENDPOINT {
        return Response::not_found();
    }
    let Some(token) = authorization.and_then(|value| value.strip_prefix("Bearer ")) else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let (decision, correlation) = match decode(value, token, &mut verifier, now_millis()) {
        Ok(value) => value,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    let desired = match desired_from_decision(&decision) {
        Ok(desired) => desired,
        Err(()) => return Response::bad_request(),
    };

    match settings_handle.replace(correlation, desired, call).await {
        Ok(receipt) => Response {
            status: 202,
            body: json!(receipt),
        },
        Err(_) => Response::unavailable(),
    }
}

fn desired_from_decision(value: &Value) -> Result<Desired, ()> {
    let input = value.get("input").and_then(Value::as_object).ok_or(())?;
    let browser_mode = match input.get("browserMode").and_then(Value::as_str).ok_or(())? {
        "native" => BrowserMode::Native,
        "relay" => BrowserMode::Relay,
        "off" => BrowserMode::Off,
        _ => return Err(()),
    };
    let launch_at_startup = input
        .get("launchAtStartup")
        .and_then(Value::as_bool)
        .ok_or(())?;
    let gateway_auto_start = input
        .get("gatewayAutoStart")
        .and_then(Value::as_bool)
        .ok_or(())?;
    let proxy = input.get("proxy").and_then(Value::as_object).ok_or(())?;
    if proxy.get("credentialReference") != Some(&Value::Null) {
        return Err(());
    }
    let proxy = ProxyDesired {
        enabled: proxy.get("enabled").and_then(Value::as_bool).ok_or(())?,
        server: proxy
            .get("server")
            .and_then(Value::as_str)
            .ok_or(())?
            .to_owned(),
        bypass_rules: proxy
            .get("bypassRules")
            .and_then(Value::as_str)
            .ok_or(())?
            .to_owned(),
    };
    Desired::try_new(browser_mode, proxy, launch_at_startup, gateway_auto_start).map_err(|_| ())
}

struct Response {
    status: u16,
    body: Value,
}
impl From<Response> for loopback::Response {
    fn from(response: Response) -> Self {
        Self::json(response.status, response.body)
    }
}

impl Response {
    fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }
    #[cfg(test)]
    fn settled(revision: u64, outcome: crate::application::receipts::Outcome) -> Self {
        use crate::application::receipts::Outcome;

        match outcome {
            Outcome::Rejected => Self::fixed(422, "Settings desired request was rejected"),
            Outcome::Confirmed | Outcome::Unknown => Self::ok(
                json!({ "desired": { "revision": revision, "outcome": outcome.as_str() } }),
            ),
        }
    }
    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: json!({"success": false, "error": error}),
        }
    }
    fn unavailable() -> Self {
        Self::fixed(503, "Settings call is unavailable")
    }
    fn bad_request() -> Self {
        Self::fixed(400, "Settings desired request is invalid")
    }
    fn unauthorized() -> Self {
        Self::fixed(401, "Settings desired authorization is invalid")
    }
    fn not_found() -> Self {
        Self::fixed(404, "Settings desired route is not available")
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::Response;
    use crate::application::receipts::Outcome;

    #[test]
    fn unchanged_projection_confirms_without_a_restart() {
        assert_eq!(Response::settled(7, Outcome::Confirmed).status, 200);
    }

    #[test]
    fn response_keeps_unknown_recoverable_and_rejection_fixed() {
        let unknown = Response::settled(7, Outcome::Unknown);
        assert_eq!(unknown.status, 200);
        assert_eq!(unknown.body["desired"]["outcome"], "outcome_unknown");

        let rejected = Response::settled(7, Outcome::Rejected);
        assert_eq!(rejected.status, 422);
        assert_eq!(rejected.body["success"], false);
    }
}
