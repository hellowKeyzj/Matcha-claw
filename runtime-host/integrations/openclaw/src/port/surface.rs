use std::sync::atomic::{AtomicU64, Ordering};

use reqwest::Url;
use serde_json::{Map, Value, json};

use super::{
    OpenClawGateway,
    outcome::{OpenClawGatewayRequestOutcome, OpenClawSurfaceFailure},
};
use crate::gateway::{
    delivery::{DispatcherError, MutationDelivery},
    request::{
        OpenClawCanvasGatewayRequest, OpenClawMcpAppGatewayRequest, OpenClawMcpAppOperation,
        OpenClawProgressCardGatewayRequest,
    },
    wire::{self, GatewayResponse},
};

type SurfaceResult = Result<Value, OpenClawSurfaceFailure>;

impl OpenClawGateway {
    pub async fn progress_card_request(
        &self,
        request: OpenClawProgressCardGatewayRequest,
    ) -> OpenClawGatewayRequestOutcome {
        let wire = match wire::progress_card_request(next_request_id(), &request) {
            Ok(wire) => wire,
            Err(_) => return rejected(OpenClawSurfaceFailure::InvalidRequest),
        };
        let response = match self.client.rpc_query(wire).await {
            Ok(response) => response,
            Err(_) => return rejected(OpenClawSurfaceFailure::Unavailable),
        };
        let result = surface_payload(MutationDelivery::Response(response))
            .and_then(|payload| project_progress_card(payload, &request));
        match result {
            Ok(payload) => OpenClawGatewayRequestOutcome::Succeeded(payload),
            Err(failure) => rejected(failure),
        }
    }

    pub async fn mcp_app_request(
        &self,
        request: OpenClawMcpAppGatewayRequest,
    ) -> OpenClawGatewayRequestOutcome {
        let wire = match wire::mcp_app_request(next_request_id(), &request) {
            Ok(wire) => wire,
            Err(_) => return rejected(OpenClawSurfaceFailure::InvalidRequest),
        };
        let payload = match surface_payload(self.client.rpc_mutation(wire).await) {
            Ok(payload) => payload,
            Err(OpenClawSurfaceFailure::InvalidResponse)
                if request.operation.has_side_effects() =>
            {
                return rejected(OpenClawSurfaceFailure::OutcomeUnknown);
            }
            Err(failure) => return rejected(failure),
        };
        match project_mcp_result(payload, &request, &self.client.http_origin()) {
            Ok(payload) => OpenClawGatewayRequestOutcome::Succeeded(payload),
            Err(_) if request.operation.has_side_effects() => {
                rejected(OpenClawSurfaceFailure::OutcomeUnknown)
            }
            Err(failure) => rejected(failure),
        }
    }

    pub async fn canvas_request(
        &self,
        request: OpenClawCanvasGatewayRequest,
    ) -> OpenClawGatewayRequestOutcome {
        let wire = match wire::canvas_request(next_request_id(), &request) {
            Ok(wire) => wire,
            Err(_) => return rejected(OpenClawSurfaceFailure::InvalidRequest),
        };
        let payload = match surface_payload(self.client.rpc_mutation(wire).await) {
            Ok(payload) => payload,
            Err(failure) => return rejected(failure),
        };
        let result = (|| {
            let native = payload
                .as_object()
                .ok_or(OpenClawSurfaceFailure::InvalidResponse)?;
            Ok(json!({
                "sessionIdentity": request.session_identity,
                "documentId": request.doc_id,
                "html": surface_html(native)?,
                "sandboxUrl": sandbox_url(native, &self.client.http_origin())?,
            }))
        })();
        match result {
            Ok(payload) => OpenClawGatewayRequestOutcome::Succeeded(payload),
            Err(failure) => rejected(failure),
        }
    }
}

fn next_request_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("matcha-surface-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn rejected(failure: OpenClawSurfaceFailure) -> OpenClawGatewayRequestOutcome {
    OpenClawGatewayRequestOutcome::SurfaceRejected(failure)
}

fn surface_payload(delivery: MutationDelivery) -> SurfaceResult {
    match delivery {
        MutationDelivery::Response(GatewayResponse::Success {
            payload: Some(payload),
            ..
        }) => Ok(payload),
        MutationDelivery::Response(GatewayResponse::Success { payload: None, .. }) => {
            Err(OpenClawSurfaceFailure::InvalidResponse)
        }
        MutationDelivery::Response(GatewayResponse::Failure { error, .. }) => {
            Err(if error.mcp_app_view_expired {
                OpenClawSurfaceFailure::ViewExpired
            } else if error.code() == "INVALID_REQUEST" {
                OpenClawSurfaceFailure::InvalidRequest
            } else {
                OpenClawSurfaceFailure::Rejected
            })
        }
        MutationDelivery::NotWritten(DispatcherError::Saturated) => {
            Err(OpenClawSurfaceFailure::CapacityExhausted)
        }
        MutationDelivery::NotWritten(_) => Err(OpenClawSurfaceFailure::Unavailable),
        MutationDelivery::MayHaveReached(_) => Err(OpenClawSurfaceFailure::OutcomeUnknown),
    }
}

fn project_progress_card(
    payload: Value,
    request: &OpenClawProgressCardGatewayRequest,
) -> SurfaceResult {
    let invalid = OpenClawSurfaceFailure::InvalidResponse;
    let result = payload
        .as_object()
        .filter(|object| object.len() == 1)
        .ok_or(invalid)?;
    let card = result.get("card").ok_or(invalid)?;
    if !card.is_null() {
        let card = card.as_object().ok_or(invalid)?;
        if !card.keys().all(|key| {
            matches!(
                key.as_str(),
                "sessionKey" | "revision" | "updatedAt" | "markdown" | "steps"
            )
        }) {
            return Err(invalid);
        }
        let identity = &request.session_identity;
        let observer_key = match identity.session_key.as_str() {
            "global" | "unknown" => format!("agent:{}:{}", identity.agent_id, identity.session_key),
            _ => identity.session_key.clone(),
        };
        if card.get("sessionKey").and_then(Value::as_str) != Some(observer_key.as_str())
            || !card
                .get("revision")
                .and_then(Value::as_u64)
                .is_some_and(|revision| (1..=9_007_199_254_740_991).contains(&revision))
            || !card
                .get("updatedAt")
                .and_then(Value::as_i64)
                .is_some_and(|time| {
                    (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&time)
                })
            || card
                .get("markdown")
                .is_some_and(|text| !text.as_str().is_some_and(|text| text.len() <= 8192))
        {
            return Err(invalid);
        }
        if let Some(steps) = card.get("steps") {
            let steps = steps
                .as_array()
                .filter(|steps| steps.len() <= 50)
                .ok_or(invalid)?;
            let mut in_progress = 0;
            for step in steps {
                let step = step
                    .as_object()
                    .filter(|step| step.len() == 2)
                    .ok_or(invalid)?;
                if !step
                    .get("step")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty() && text.len() <= 512)
                {
                    return Err(invalid);
                }
                match step.get("status").and_then(Value::as_str) {
                    Some("pending" | "completed") => {}
                    Some("in_progress") => in_progress += 1,
                    _ => return Err(invalid),
                }
            }
            if in_progress > 1 {
                return Err(invalid);
            }
        }
    }
    Ok(json!({ "sessionIdentity": request.session_identity, "card": card }))
}

fn project_mcp_result(
    payload: Value,
    request: &OpenClawMcpAppGatewayRequest,
    origin: &str,
) -> SurfaceResult {
    let native = payload
        .as_object()
        .ok_or(OpenClawSurfaceFailure::InvalidResponse)?;
    let mut result = Map::new();
    match &request.operation {
        OpenClawMcpAppOperation::View => {
            let message_supported = native
                .get("messageSupported")
                .and_then(Value::as_bool)
                .ok_or(OpenClawSurfaceFailure::InvalidResponse)?;
            let context_supported = native
                .get("updateModelContextSupported")
                .and_then(Value::as_bool)
                .ok_or(OpenClawSurfaceFailure::InvalidResponse)?;
            if context_supported && !message_supported {
                return Err(OpenClawSurfaceFailure::InvalidResponse);
            }
            result.insert("sessionIdentity".into(), json!(request.session_identity));
            result.insert("viewId".into(), json!(request.view_id));
            result.insert("html".into(), json!(surface_html(native)?));
            result.insert("sandboxUrl".into(), json!(sandbox_url(native, origin)?));
            result.insert(
                "toolInput".into(),
                native
                    .get("toolInput")
                    .cloned()
                    .ok_or(OpenClawSurfaceFailure::InvalidResponse)?,
            );
            result.insert(
                "toolResult".into(),
                native
                    .get("toolResult")
                    .cloned()
                    .ok_or(OpenClawSurfaceFailure::InvalidResponse)?,
            );
            result.insert("readOnly".into(), json!(!message_supported));
            result.insert("messageSupported".into(), json!(message_supported));
            result.insert(
                "updateModelContextSupported".into(),
                json!(context_supported),
            );
            if let Some(csp) = native.get("csp") {
                result.insert("csp".into(), project_csp(csp)?);
            }
        }
        OpenClawMcpAppOperation::CallTool { .. } => {
            copy_array(native, &mut result, "content", false)?;
            for key in ["structuredContent", "_meta"] {
                if let Some(value) = native.get(key) {
                    if !value.is_object() {
                        return Err(OpenClawSurfaceFailure::InvalidResponse);
                    }
                    result.insert(key.into(), value.clone());
                }
            }
            if let Some(value) = native.get("isError") {
                if !value.is_boolean() {
                    return Err(OpenClawSurfaceFailure::InvalidResponse);
                }
                result.insert("isError".into(), value.clone());
            }
        }
        OpenClawMcpAppOperation::ListTools { .. } => copy_list(native, &mut result, "tools")?,
        OpenClawMcpAppOperation::ListResources { .. } => {
            copy_list(native, &mut result, "resources")?
        }
        OpenClawMcpAppOperation::ListResourceTemplates { .. } => {
            copy_list(native, &mut result, "resourceTemplates")?
        }
        OpenClawMcpAppOperation::ReadResource { .. } => {
            copy_array(native, &mut result, "contents", true)?
        }
        OpenClawMcpAppOperation::UpdateModelContext { .. } => {
            if !native.is_empty() {
                return Err(OpenClawSurfaceFailure::InvalidResponse);
            }
        }
    }
    Ok(Value::Object(result))
}

fn copy_array(
    native: &Map<String, Value>,
    result: &mut Map<String, Value>,
    field: &str,
    objects: bool,
) -> Result<(), OpenClawSurfaceFailure> {
    let value = native
        .get(field)
        .and_then(Value::as_array)
        .ok_or(OpenClawSurfaceFailure::InvalidResponse)?;
    if objects && value.iter().any(|value| !value.is_object()) {
        return Err(OpenClawSurfaceFailure::InvalidResponse);
    }
    result.insert(field.into(), json!(value));
    Ok(())
}

fn copy_list(
    native: &Map<String, Value>,
    result: &mut Map<String, Value>,
    field: &str,
) -> Result<(), OpenClawSurfaceFailure> {
    copy_array(native, result, field, true)?;
    if let Some(cursor) = native.get("nextCursor") {
        let text = cursor
            .as_str()
            .ok_or(OpenClawSurfaceFailure::InvalidResponse)?;
        if !valid_text(text, 4096) {
            return Err(OpenClawSurfaceFailure::InvalidResponse);
        }
        result.insert("nextCursor".into(), cursor.clone());
    }
    Ok(())
}

fn project_csp(value: &Value) -> SurfaceResult {
    let native = value
        .as_object()
        .ok_or(OpenClawSurfaceFailure::InvalidResponse)?;
    let mut result = Map::new();
    for field in [
        "connectDomains",
        "resourceDomains",
        "frameDomains",
        "baseUriDomains",
    ] {
        if let Some(value) = native.get(field) {
            let domains = value
                .as_array()
                .ok_or(OpenClawSurfaceFailure::InvalidResponse)?;
            if domains.iter().any(|domain| {
                !domain
                    .as_str()
                    .is_some_and(|domain| valid_text(domain, 2048))
            }) {
                return Err(OpenClawSurfaceFailure::InvalidResponse);
            }
            result.insert(field.into(), value.clone());
        }
    }
    if let Some(value) = native.get("blockDescendantFrames") {
        if !value.is_boolean() {
            return Err(OpenClawSurfaceFailure::InvalidResponse);
        }
        result.insert("blockDescendantFrames".into(), value.clone());
    }
    Ok(Value::Object(result))
}

fn surface_html(native: &Map<String, Value>) -> Result<&str, OpenClawSurfaceFailure> {
    native
        .get("html")
        .and_then(Value::as_str)
        .filter(|html| html.len() <= 2 * 1024 * 1024)
        .ok_or(OpenClawSurfaceFailure::InvalidResponse)
}

fn sandbox_url(
    native: &Map<String, Value>,
    gateway_origin: &str,
) -> Result<String, OpenClawSurfaceFailure> {
    let invalid = OpenClawSurfaceFailure::InvalidResponse;
    let gateway = Url::parse(gateway_origin).map_err(|_| invalid)?;
    let port = native
        .get("sandboxPort")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .ok_or(invalid)? as u16;
    let mut base = match native.get("sandboxOrigin") {
        Some(value) => {
            let text = value
                .as_str()
                .filter(|text| valid_text(text, 4096))
                .ok_or(invalid)?;
            let base = Url::parse(text).map_err(|_| invalid)?;
            if base.origin().ascii_serialization() != text.trim_end_matches('/')
                || base.path() != "/"
                || base.query().is_some()
                || base.fragment().is_some()
            {
                return Err(invalid);
            }
            base
        }
        None => {
            let mut base = gateway.clone();
            base.set_port(Some(port)).map_err(|_| invalid)?;
            base
        }
    };
    if !matches!(base.scheme(), "http" | "https")
        || !base.username().is_empty()
        || base.password().is_some()
        || base.origin() == gateway.origin()
    {
        return Err(invalid);
    }
    base.set_path("/");
    base.set_query(None);
    base.set_fragment(None);
    let path = native
        .get("sandboxUrl")
        .and_then(Value::as_str)
        .filter(|path| valid_text(path, 12 * 1024))
        .ok_or(invalid)?;
    if path != "/mcp-app-sandbox" && !path.starts_with("/mcp-app-sandbox?") {
        return Err(invalid);
    }
    let resolved = base.join(path).map_err(|_| invalid)?;
    if resolved.origin() != base.origin()
        || resolved.path() != "/mcp-app-sandbox"
        || resolved.fragment().is_some()
        || !resolved.username().is_empty()
        || resolved.password().is_some()
    {
        return Err(invalid);
    }
    let mut queries = resolved.query_pairs();
    if let Some((key, value)) = queries.next() {
        if key != "csp"
            || value.is_empty()
            || value.len() > 6832
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || queries.next().is_some()
        {
            return Err(invalid);
        }
    } else if resolved.query().is_some() {
        return Err(invalid);
    }
    Ok(resolved.into())
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
