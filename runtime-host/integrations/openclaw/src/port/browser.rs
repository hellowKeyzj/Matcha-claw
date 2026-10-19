mod image;
mod input;

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};

use super::{OpenClawGateway, OpenClawGatewayRequestOutcome, outcome::gateway_request_outcome};
use crate::gateway::{delivery::MutationDelivery, request::OpenClawBrowserGatewayRequest, wire};

const MAX_VIEWPORT_DIMENSION: u64 = 8192;

#[derive(Clone, Copy)]
enum Operation {
    Status,
    Tabs,
    Start,
    Tab,
    Mutation,
    Screenshot,
    FixedAction { input: bool },
}

impl OpenClawGateway {
    pub async fn browser_request(
        &self,
        mut request: OpenClawBrowserGatewayRequest,
    ) -> OpenClawGatewayRequestOutcome {
        let operation = match input::normalize(&mut request) {
            Ok(operation) => operation,
            Err(()) => return OpenClawGatewayRequestOutcome::Rejected,
        };
        let rpc = match browser_rpc(request.clone()) {
            Ok(rpc) => rpc,
            Err(_) => return OpenClawGatewayRequestOutcome::Rejected,
        };
        let delivery = self.client.rpc_mutation(rpc).await;
        if let (
            Operation::FixedAction { .. },
            MutationDelivery::Response(wire::GatewayResponse::Failure { error, .. }),
        ) = (operation, &delivery)
        {
            match error.browser_act_code() {
                Some("ACT_EVALUATE_DISABLED") => {
                    return operation_failure("browser_evaluation_disabled");
                }
                Some("ACT_EXISTING_SESSION_UNSUPPORTED" | "ACT_SELECTOR_UNSUPPORTED") => {
                    return operation_failure("browser_operation_unsupported");
                }
                _ => {}
            }
        }
        let payload = match gateway_request_outcome(delivery) {
            OpenClawGatewayRequestOutcome::Succeeded(payload) => payload,
            outcome => return outcome,
        };
        if let Operation::Screenshot = operation {
            return self.browser_screenshot(request, payload).await;
        }
        if let Operation::FixedAction { input } = operation {
            match payload.get("result").and_then(Value::as_bool) {
                Some(true) => {}
                Some(false) => {
                    return operation_failure(if input {
                        "browser_input_unsupported"
                    } else {
                        "browser_operation_unsupported"
                    });
                }
                None if payload.get("blockedByDialog").and_then(Value::as_bool) == Some(true) => {
                    return operation_failure("browser_operation_unsupported");
                }
                None => return OpenClawGatewayRequestOutcome::OutcomeUnknown,
            }
        }
        match project_payload(operation, &payload) {
            Ok(payload) => OpenClawGatewayRequestOutcome::Succeeded(payload),
            Err(()) if matches!(operation, Operation::Status | Operation::Tabs) => {
                OpenClawGatewayRequestOutcome::Unavailable
            }
            Err(()) => OpenClawGatewayRequestOutcome::OutcomeUnknown,
        }
    }

    async fn browser_screenshot(
        &self,
        request: OpenClawBrowserGatewayRequest,
        payload: Value,
    ) -> OpenClawGatewayRequestOutcome {
        let Some(state_dir) = self.state_dir.clone() else {
            return OpenClawGatewayRequestOutcome::Unavailable;
        };
        let metadata = match project_identity(&payload, false) {
            Ok(metadata) if metadata.contains_key("targetId") => metadata,
            _ => return OpenClawGatewayRequestOutcome::Unavailable,
        };
        let image =
            tokio::task::spawn_blocking(move || image::screenshot_data_url(&state_dir, &payload))
                .await;
        let data_url = match image {
            Ok(Ok(data_url)) => data_url,
            _ => return OpenClawGatewayRequestOutcome::Unavailable,
        };
        let viewport = self.browser_viewport(request, &metadata).await;
        let mut screenshot = metadata;
        screenshot.insert("dataUrl".into(), Value::String(data_url));
        if let Some(viewport) = viewport {
            screenshot.insert("viewport".into(), viewport);
        }
        OpenClawGatewayRequestOutcome::Succeeded(Value::Object(screenshot))
    }

    async fn browser_viewport(
        &self,
        mut request: OpenClawBrowserGatewayRequest,
        screenshot: &Map<String, Value>,
    ) -> Option<Value> {
        let target_id = screenshot.get("targetId")?.as_str()?;
        request.path = "/act".into();
        request.body =
            Some(json!({"kind":"evaluate","targetId":target_id,"fn":input::VIEWPORT_FUNCTION}));
        request.timeout_ms = Some(2_000);
        let rpc = browser_rpc(request).ok()?;
        let MutationDelivery::Response(wire::GatewayResponse::Success {
            payload: Some(payload),
            ..
        }) = self.client.rpc_mutation(rpc).await
        else {
            return None;
        };
        if payload.get("targetId").and_then(Value::as_str) != Some(target_id)
            || payload.get("url") != screenshot.get("url")
        {
            return None;
        }
        let viewport = payload.get("result")?.as_object()?;
        let width = viewport.get("width")?.as_u64()?;
        let height = viewport.get("height")?.as_u64()?;
        ((1..=MAX_VIEWPORT_DIMENSION).contains(&width)
            && (1..=MAX_VIEWPORT_DIMENSION).contains(&height))
        .then(|| json!({"width":width,"height":height}))
    }
}

fn browser_rpc(
    request: OpenClawBrowserGatewayRequest,
) -> Result<wire::RpcRequest, wire::WireError> {
    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
    wire::browser_request(
        format!(
            "matcha-browser-request-{}",
            NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        ),
        request.method,
        request.path,
        request.query,
        request.body,
        request.timeout_ms,
        request.target,
        request.node,
    )
}

fn operation_failure(error_code: &str) -> OpenClawGatewayRequestOutcome {
    OpenClawGatewayRequestOutcome::Succeeded(json!({"ok":false,"errorCode":error_code}))
}

fn project_payload(operation: Operation, payload: &Value) -> Result<Value, ()> {
    let object = payload.as_object().ok_or(())?;
    match operation {
        Operation::Status => {
            let mut result = Map::new();
            for field in ["enabled", "running"] {
                result.insert(
                    field.into(),
                    Value::Bool(object.get(field).and_then(Value::as_bool).ok_or(())?),
                );
            }
            for field in ["cdpReady", "pageReady", "headless", "attachOnly"] {
                if let Some(value) = object.get(field).and_then(Value::as_bool) {
                    result.insert(field.into(), Value::Bool(value));
                }
            }
            for field in ["profile", "driver"] {
                copy_text(object, &mut result, field, 256)?;
            }
            if let Some(transport) = object.get("transport").and_then(Value::as_str) {
                if !matches!(transport, "cdp" | "extension" | "chrome-mcp") {
                    return Err(());
                }
                result.insert("transport".into(), transport.into());
            }
            Ok(Value::Object(result))
        }
        Operation::Tabs => {
            let tabs = object.get("tabs").and_then(Value::as_array).ok_or(())?;
            if tabs.len() > 1024 {
                return Err(());
            }
            let mut ids = std::collections::HashSet::new();
            let mut projected = Vec::with_capacity(tabs.len());
            for tab in tabs {
                let tab = project_identity(tab, true)?;
                if !ids.insert(
                    tab.get("targetId")
                        .and_then(Value::as_str)
                        .ok_or(())?
                        .to_owned(),
                ) {
                    return Err(());
                }
                projected.push(Value::Object(tab));
            }
            let mut result = json!({"tabs":projected});
            if let Some(running) = object.get("running").and_then(Value::as_bool) {
                result["running"] = Value::Bool(running);
            }
            Ok(result)
        }
        Operation::Tab => Ok(Value::Object(project_identity(payload, true)?)),
        Operation::Start => {
            if object.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(());
            }
            let mut result = json!({"ok":true});
            if let Some(profile) = object
                .get("profile")
                .and_then(Value::as_str)
                .filter(|profile| text(profile, 256))
            {
                result["profile"] = profile.into();
            }
            Ok(result)
        }
        Operation::Mutation | Operation::FixedAction { .. } => {
            if object.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(());
            }
            if object.get("blockedByDialog").and_then(Value::as_bool) == Some(true) {
                return Ok(json!({"ok":false,"errorCode":"browser_operation_unsupported"}));
            }
            let mut result = project_identity(payload, false)?;
            result.insert("ok".into(), Value::Bool(true));
            Ok(Value::Object(result))
        }
        Operation::Screenshot => Err(()),
    }
}

fn project_identity(payload: &Value, tab: bool) -> Result<Map<String, Value>, ()> {
    let object = payload.as_object().ok_or(())?;
    let mut result = Map::new();
    for field in ["targetId", "tabId"] {
        copy_text(object, &mut result, field, 256)?;
    }
    if tab && !result.contains_key("targetId") {
        return Err(());
    }
    if let Some(url) = object
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| public_url(url))
    {
        result.insert("url".into(), url.into());
    }
    if tab {
        if let Some(title) = object.get("title") {
            let title = title
                .as_str()
                .filter(|title| title.encode_utf16().count() <= 16_384 && !title.contains('\0'))
                .ok_or(())?;
            result.insert("title".into(), title.into());
        }
        if let Some(active) = object.get("active").and_then(Value::as_bool) {
            result.insert("active".into(), Value::Bool(active));
        }
    }
    Ok(result)
}

fn copy_text(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    field: &str,
    limit: usize,
) -> Result<(), ()> {
    if let Some(value) = source.get(field) {
        let value = value
            .as_str()
            .filter(|value| text(value, limit))
            .ok_or(())?;
        target.insert(field.into(), value.into());
    }
    Ok(())
}

fn text(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= limit
        && value.trim() == value
        && !value.chars().any(|value| value.is_ascii_control())
}

fn public_url(value: &str) -> bool {
    if !text(value, 16_384) {
        return false;
    }
    if value == "about:blank" {
        return true;
    }
    reqwest::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
    })
}
