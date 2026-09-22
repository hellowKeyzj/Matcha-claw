use platform::capability::CapabilityDecisionVerifier;

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::adapters::loopback::trace as session_trace;

use super::{SessionModelSelectionDelivery, SessionModelSelectionRequest};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const REJECTION_REASON_HEADER: &str = "x-runtime-host-session-model-rejection";
const OPENCLAW_PEER_CODE_HEADER: &str = "x-runtime-host-session-model-openclaw-code";
const OPENCLAW_PEER_MESSAGE_HEADER: &str = "x-runtime-host-session-model-openclaw-message";
const DIAGNOSTIC_ACCOUNT_HEADER: &str = "x-runtime-host-session-model-account";
const DIAGNOSTIC_MODEL_HEADER: &str = "x-runtime-host-session-model-model";
const DIAGNOSTIC_PROTOCOL_HEADER: &str = "x-runtime-host-session-model-protocol";
const DIAGNOSTIC_AUTH_MODE_HEADER: &str = "x-runtime-host-session-model-auth-mode";
const MAX_DIAGNOSTIC_HEADER_BYTES: usize = 1024;

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> Response {
    handle_request(
        Request {
            method: method.to_owned(),
            path: path.to_owned(),
            headers: headers.to_vec(),
            body: body.to_vec(),
        },
        verifier,
        session,
    )
    .await
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> Response {
    if request.method != "POST" || request.path != "/api/sessions/model" {
        return Response::not_found();
    }
    let trace_id = session_trace::trace_id(&request.headers);
    session_trace::log(
        "runtime.model-selection.request",
        trace_id,
        serde_json::json!({ "method": &request.method, "path": &request.path }),
    );
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        session_trace::log(
            "runtime.model-selection.unauthorized",
            trace_id,
            serde_json::json!({}),
        );
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log(
                "runtime.model-selection.bad-json",
                trace_id,
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    let mut verifier = verifier.lock().await;
    let request = match SessionModelSelectionRequest::decode(
        value,
        authorization,
        &mut verifier,
        now_millis(),
    ) {
        Ok(request) => request,
        Err(super::DecodeError::Unauthorized) => {
            session_trace::log(
                "runtime.model-selection.decode-unauthorized",
                trace_id,
                serde_json::json!({}),
            );
            return Response::unauthorized();
        }
        Err(super::DecodeError::Invalid) => {
            session_trace::log(
                "runtime.model-selection.decode-invalid",
                trace_id,
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    let command = match request.into_command(trace_id.map(str::to_owned)) {
        Ok(command) => command,
        Err(_) => {
            session_trace::log(
                "runtime.model-selection.command-invalid",
                trace_id,
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    session_trace::log(
        "runtime.model-selection.command",
        trace_id,
        serde_json::json!({
            "endpoint": format!("{:?}", command.endpoint),
            "sessionKey": session_trace::id_shape(Some(&command.session_key)),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id.as_deref()),
            "modelSelectionId": session_trace::id_shape(Some(&command.model_selection_id)),
        }),
    );
    if matches!(
        command.endpoint,
        crate::model_selection::NativeEndpoint::Unsupported
    ) {
        session_trace::log(
            "runtime.model-selection.unsupported",
            trace_id,
            serde_json::json!({}),
        );
        return Response::from_delivery(SessionModelSelectionDelivery::Unsupported);
    }
    drop(verifier);
    let outcome = match session.select_model(command).await {
        Ok(outcome) => outcome,
        Err(_) => {
            session_trace::log(
                "runtime.model-selection.owner-unavailable",
                trace_id,
                serde_json::json!({}),
            );
            return Response::unavailable();
        }
    };
    let delivery = SessionModelSelectionDelivery::from(outcome);
    session_trace::log(
        "runtime.model-selection.outcome",
        trace_id,
        serde_json::json!({
            "status": delivery.status_code(),
            "rejectionReason": delivery.rejection_reason(),
        }),
    );
    Response::from_delivery(delivery)
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

pub(crate) struct Response {
    pub(crate) status: u16,
    pub(crate) body: Value,
    rejection_reason: Option<&'static str>,
    openclaw_peer_code: Option<String>,
    openclaw_peer_message: Option<String>,
    diagnostic_account: Option<String>,
    diagnostic_model: Option<String>,
    diagnostic_protocol: Option<&'static str>,
    diagnostic_auth_mode: Option<&'static str>,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Session model selection request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session model selection authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Session model selection route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(SessionModelSelectionDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
            rejection_reason: None,
            openclaw_peer_code: None,
            openclaw_peer_message: None,
            diagnostic_account: None,
            diagnostic_model: None,
            diagnostic_protocol: None,
            diagnostic_auth_mode: None,
        }
    }

    fn from_delivery(delivery: SessionModelSelectionDelivery) -> Self {
        let rejection_reason = delivery.rejection_reason();
        let openclaw_peer = delivery.openclaw_patch_rejection().map(|rejection| {
            (
                header_value(rejection.code()),
                header_value(rejection.message()),
            )
        });
        let diagnostic = delivery.diagnostic();
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
            rejection_reason,
            openclaw_peer_code: openclaw_peer.as_ref().map(|(code, _)| code.clone()),
            openclaw_peer_message: openclaw_peer.map(|(_, message)| message),
            diagnostic_account: diagnostic.map(|diagnostic| header_value(diagnostic.account_id())),
            diagnostic_model: diagnostic.map(|diagnostic| header_value(diagnostic.model_id())),
            diagnostic_protocol: diagnostic.and_then(|diagnostic| diagnostic.protocol()),
            diagnostic_auth_mode: diagnostic.map(|diagnostic| diagnostic.auth_mode()),
        }
    }

    pub(crate) fn diagnostic_headers(&self) -> String {
        let mut headers = String::new();
        if let Some(reason) = self.rejection_reason {
            headers.push_str(&format!("{REJECTION_REASON_HEADER}: {reason}\r\n"));
        }
        if let Some(code) = self.openclaw_peer_code.as_deref() {
            headers.push_str(&format!("{OPENCLAW_PEER_CODE_HEADER}: {code}\r\n"));
        }
        if let Some(message) = self.openclaw_peer_message.as_deref() {
            headers.push_str(&format!("{OPENCLAW_PEER_MESSAGE_HEADER}: {message}\r\n"));
        }
        if let Some(account) = self.diagnostic_account.as_deref() {
            headers.push_str(&format!("{DIAGNOSTIC_ACCOUNT_HEADER}: {account}\r\n"));
        }
        if let Some(model) = self.diagnostic_model.as_deref() {
            headers.push_str(&format!("{DIAGNOSTIC_MODEL_HEADER}: {model}\r\n"));
        }
        if let Some(protocol) = self.diagnostic_protocol {
            headers.push_str(&format!("{DIAGNOSTIC_PROTOCOL_HEADER}: {protocol}\r\n"));
        }
        if let Some(auth_mode) = self.diagnostic_auth_mode {
            headers.push_str(&format!("{DIAGNOSTIC_AUTH_MODE_HEADER}: {auth_mode}\r\n"));
        }
        headers
    }
}

fn header_value(value: &str) -> String {
    let mut header = String::with_capacity(value.len().min(MAX_DIAGNOSTIC_HEADER_BYTES));
    for character in value.chars() {
        let character = match character {
            '\r' | '\n' => ' ',
            value if value.is_control() => continue,
            value => value,
        };
        if header.len() + character.len_utf8() > MAX_DIAGNOSTIC_HEADER_BYTES {
            break;
        }
        header.push(character);
    }
    header
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
