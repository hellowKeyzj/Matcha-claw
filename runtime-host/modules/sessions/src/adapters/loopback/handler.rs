use platform::{capability::CapabilityDecisionVerifier, loopback};

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use super::{
    DecodeError, SessionListDelivery, SessionListRequest, abort, approval, content, create, delete,
    history, map_catalog_outcome, model_selection, permission, rename, send, timeline,
    trace as session_trace,
};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
pub(crate) async fn handle_loopback(
    request: &loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
    send_hooks: crate::send_hook::SessionSendHookSet,
) -> Option<loopback::Response> {
    route(
        request.method(),
        request.path(),
        request.headers(),
        &request.body,
        verifier,
        session,
        send_hooks,
    )
    .await
    .map(Response::into_loopback_response)
}

async fn route(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
    send_hooks: crate::send_hook::SessionSendHookSet,
) -> Option<Response> {
    if !is_loopback_route(path) {
        return None;
    }
    if method != "POST" {
        return Some(Response::not_found());
    }
    if path == "/api/sessions/create" {
        let response = create::handler::handle(headers, body, verifier, session.clone()).await;
        return Some(Response::from_create(response));
    }
    if path == "/api/sessions/delete" {
        let response = delete::handler::handle(headers, body, verifier, session.clone()).await;
        return Some(Response::from_delete(response));
    }
    if path == "/api/sessions/rename" {
        return Some(Response::from_rename(
            rename::handle(headers, body, verifier, session.clone()).await,
        ));
    }
    if path == "/api/sessions/permission" {
        return Some(Response::from_permission(
            permission::handler::handle(headers, body, verifier, session.clone()).await,
        ));
    }
    if path == "/api/sessions/send" {
        return Some(Response::from_send(
            send::handler::handle(
                method,
                path,
                headers,
                body,
                verifier,
                session.clone(),
                send_hooks.clone(),
            )
            .await,
        ));
    }
    if path == "/api/sessions/abort" {
        return Some(Response::from_abort(
            abort::handler::handle(method, path, headers, body, verifier, session.clone()).await,
        ));
    }
    if matches!(
        path,
        "/api/sessions/approvals/list" | "/api/sessions/approvals/respond"
    ) {
        return Some(Response::from_approval(
            approval::handler::handle(method, path, headers, body, verifier, session.clone()).await,
        ));
    }
    if path == "/api/sessions/model" {
        return Some(Response::from_model_selection(
            model_selection::handler::handle(
                method,
                path,
                headers,
                body,
                verifier,
                session.clone(),
            )
            .await,
        ));
    }
    if matches!(path, "/api/sessions/load" | "/api/sessions/window") {
        return Some(handle_timeline(method, path, headers, body, verifier, session).await);
    }
    if path == "/api/sessions/content" {
        return Some(handle_content(method, path, headers, body, verifier, session).await);
    }
    if path == "/api/sessions/history" {
        return Some(handle_history(method, path, headers, body, verifier, session).await);
    }
    if path != "/api/sessions" {
        return Some(Response::not_found());
    }
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Some(Response::unauthorized());
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => return Some(Response::bad_request()),
    };
    let mut verifier = verifier.lock().await;
    let request =
        match SessionListRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(DecodeError::Unauthorized) => return Some(Response::unauthorized()),
            Err(DecodeError::Invalid) => return Some(Response::bad_request()),
        };
    let Some(command) = request.into_command() else {
        return Some(Response::bad_request());
    };
    drop(verifier);
    let delivery = match session.list_session_catalog(command).await {
        Ok(result) => map_catalog_outcome(result),
        Err(_) => SessionListDelivery::Unavailable,
    };
    Some(Response::from_delivery(delivery))
}

fn is_loopback_route(path: &str) -> bool {
    matches!(
        path,
        "/api/sessions/create"
            | "/api/sessions/delete"
            | "/api/sessions/rename"
            | "/api/sessions/permission"
            | "/api/sessions/send"
            | "/api/sessions/abort"
            | "/api/sessions/approvals/list"
            | "/api/sessions/approvals/respond"
            | "/api/sessions/model"
            | "/api/sessions/load"
            | "/api/sessions/window"
            | "/api/sessions/content"
            | "/api/sessions/history"
            | "/api/sessions"
    )
}

async fn handle_content(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> Response {
    let trace_id = session_trace::trace_id(headers);
    session_trace::log(
        "runtime.content.request",
        trace_id,
        serde_json::json!({ "method": method, "path": path }),
    );
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::content_unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => return Response::content_bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match content::Request::decode(value, authorization, &mut verifier, now_millis())
    {
        Ok(request) => request,
        Err(content::DecodeError::Unauthorized) => return Response::content_unauthorized(),
        Err(content::DecodeError::Invalid) => return Response::content_bad_request(),
    };
    let Some(command) = request.into_command() else {
        return Response::content_bad_request();
    };
    drop(verifier);
    session_trace::log(
        "runtime.content.command",
        trace_id,
        serde_json::json!({
            "provider": command.provider().as_str(),
            "sessionKey": session_trace::id_shape(Some(command.session_key())),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id()),
            "agentId": session_trace::id_shape(command.agent_id()),
            "contentRef": session_trace::id_shape(Some(command.content_ref())),
            "offset": command.offset(),
            "limit": command.limit(),
        }),
    );
    let outcome = match session.load_content(command).await {
        Ok(outcome) => outcome,
        Err(_) => return Response::content_unavailable(),
    };
    let reason = match &outcome {
        crate::timeline::ContentOutcome::Unavailable(reason) => Some(reason.as_str()),
        crate::timeline::ContentOutcome::Complete(_) => None,
    };
    let delivery = content::Delivery::from_outcome(outcome);
    session_trace::log(
        "runtime.content.outcome",
        trace_id,
        serde_json::json!({
            "status": delivery.status_code(),
            "reason": reason,
        }),
    );
    Response::from_content(delivery)
}

async fn handle_history(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> Response {
    let trace_id = session_trace::trace_id(headers);
    session_trace::log(
        "runtime.history.request",
        trace_id,
        serde_json::json!({ "method": method, "path": path }),
    );
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::history_unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => return Response::history_bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match history::Request::decode(value, authorization, &mut verifier, now_millis())
    {
        Ok(request) => request,
        Err(history::DecodeError::Unauthorized) => return Response::history_unauthorized(),
        Err(history::DecodeError::Invalid) => return Response::history_bad_request(),
    };
    let Some(command) = request.into_command() else {
        return Response::history_bad_request();
    };
    drop(verifier);
    session_trace::log(
        "runtime.history.command",
        trace_id,
        serde_json::json!({
            "endpoint": {
                "runtimeAdapterId": command.endpoint().runtime_adapter_id(),
                "runtimeInstanceId": command.endpoint().runtime_instance_id(),
            },
            "sessionKey": session_trace::id_shape(Some(command.session_key())),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id()),
            "limit": command.limit(),
        }),
    );
    let outcome = match session.load_session_history(command).await {
        Ok(outcome) => outcome,
        Err(_) => return Response::history_unavailable(),
    };
    let delivery = history::Delivery::from_outcome(outcome);
    session_trace::log(
        "runtime.history.outcome",
        trace_id,
        serde_json::json!({ "status": delivery.status_code() }),
    );
    Response::from_history(delivery)
}

async fn handle_timeline(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> Response {
    let trace_id = session_trace::trace_id(headers);
    session_trace::log(
        "runtime.timeline.request",
        trace_id,
        serde_json::json!({ "method": method, "path": path }),
    );
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        session_trace::log(
            "runtime.timeline.unauthorized",
            trace_id,
            serde_json::json!({}),
        );
        return Response::timeline_unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log("runtime.timeline.bad-json", trace_id, serde_json::json!({}));
            return Response::timeline_bad_request();
        }
    };
    let expected_operation = match path {
        "/api/sessions/load" => "sessions.load",
        "/api/sessions/window" => "sessions.window",
        _ => return Response::timeline_bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match timeline::Request::decode(value, authorization, &mut verifier, now_millis())
    {
        Ok(request) if request.operation_id() == expected_operation => request,
        Err(timeline::DecodeError::Unauthorized) => {
            session_trace::log(
                "runtime.timeline.decode-unauthorized",
                trace_id,
                serde_json::json!({}),
            );
            return Response::timeline_unauthorized();
        }
        Ok(_) | Err(timeline::DecodeError::Invalid) => {
            session_trace::log(
                "runtime.timeline.decode-invalid",
                trace_id,
                serde_json::json!({ "operation": expected_operation }),
            );
            return Response::timeline_bad_request();
        }
    };
    let identity = request.identity().clone();
    let Some(command) = request.into_command() else {
        return Response::timeline_bad_request();
    };
    drop(verifier);
    session_trace::log(
        "runtime.timeline.command",
        trace_id,
        serde_json::json!({
            "operation": expected_operation,
            "provider": command.provider().as_str(),
            "sessionKey": session_trace::id_shape(Some(command.session_key())),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id()),
            "agentId": session_trace::id_shape(command.agent_id()),
            "direction": command.direction().as_str(),
            "limit": command.limit(),
            "offset": command.offset(),
            "includeCanonical": command.include_canonical(),
        }),
    );
    let outcome = match session.load_timeline(command).await {
        Ok(outcome) => outcome,
        Err(_) => {
            session_trace::log(
                "runtime.timeline.owner-unavailable",
                trace_id,
                serde_json::json!({ "operation": expected_operation }),
            );
            return Response::timeline_unavailable();
        }
    };
    let unavailable_reason = outcome.unavailable_reason().map(|reason| reason.as_str());
    let unavailable_diagnostic = outcome.unavailable_diagnostic().map(|diagnostic| {
        serde_json::json!({
            "source": diagnostic.source(),
            "messageIndex": diagnostic.message_index(),
            "blockIndex": diagnostic.block_index(),
            "blockType": diagnostic.block_type(),
            "field": diagnostic.field(),
            "reason": diagnostic.reason(),
            "actualType": diagnostic.actual(),
        })
    });
    let delivery = timeline::Delivery::from_outcome(&identity, outcome);
    let delivery_reason = unavailable_reason
        .or_else(|| (delivery.status_code() == 503).then_some("delivery.identity_mismatch"));
    session_trace::log(
        "runtime.timeline.outcome",
        trace_id,
        serde_json::json!({
            "operation": expected_operation,
            "status": delivery.status_code(),
            "reason": delivery_reason,
            "diagnostic": unavailable_diagnostic,
        }),
    );
    Response::from_timeline(delivery)
}

struct Response {
    status: u16,
    body: Value,
    extra_headers: String,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Session list request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session list authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Session list route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
            extra_headers: String::new(),
        }
    }

    fn from_parts(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            extra_headers: String::new(),
        }
    }

    fn from_delivery(delivery: SessionListDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
            extra_headers: String::new(),
        }
    }

    fn from_create(response: create::handler::Response) -> Self {
        Self::from_parts(response.status, response.body)
    }

    fn from_delete(response: delete::handler::Response) -> Self {
        Self::from_parts(response.status, response.body)
    }

    fn from_rename(response: rename::Response) -> Self {
        Self::from_parts(response.status, response.body)
    }

    fn from_permission(response: permission::handler::Response) -> Self {
        Self::from_parts(response.status, response.body)
    }

    fn from_send(response: send::handler::Response) -> Self {
        Self::from_parts(response.status, response.body)
    }

    fn from_abort(response: abort::handler::Response) -> Self {
        Self::from_parts(response.status, response.body)
    }

    fn from_approval(response: approval::handler::Response) -> Self {
        Self::from_parts(response.status, response.body)
    }

    fn from_model_selection(response: model_selection::handler::Response) -> Self {
        let extra_headers = response.diagnostic_headers();
        Self {
            status: response.status,
            body: response.body,
            extra_headers,
        }
    }

    fn timeline_bad_request() -> Self {
        Self::fixed(400, "Session timeline request is invalid")
    }

    fn timeline_unauthorized() -> Self {
        Self::fixed(401, "Session timeline authorization is invalid")
    }

    fn timeline_unavailable() -> Self {
        Self::from_timeline(timeline::Delivery::Unavailable)
    }

    fn from_timeline(delivery: timeline::Delivery) -> Self {
        Self::from_parts(delivery.status_code(), delivery.body())
    }

    fn content_bad_request() -> Self {
        Self::fixed(400, "Session content request is invalid")
    }

    fn content_unauthorized() -> Self {
        Self::fixed(401, "Session content authorization is invalid")
    }

    fn content_unavailable() -> Self {
        Self::from_content(content::Delivery::Unavailable)
    }

    fn from_content(delivery: content::Delivery) -> Self {
        Self::from_parts(delivery.status_code(), delivery.body())
    }

    fn history_bad_request() -> Self {
        Self::fixed(400, "Session history request is invalid")
    }

    fn history_unauthorized() -> Self {
        Self::fixed(401, "Session history authorization is invalid")
    }

    fn history_unavailable() -> Self {
        Self::from_history(history::Delivery::Unavailable)
    }

    fn from_history(delivery: history::Delivery) -> Self {
        Self::from_parts(delivery.status_code(), delivery.body())
    }

    fn into_loopback_response(self) -> loopback::Response {
        loopback::Response::json(self.status, self.body).with_raw_headers(self.extra_headers)
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
