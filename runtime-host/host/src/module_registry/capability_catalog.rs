use std::{
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use platform::{
    loopback::{
        BodyPolicy, ModuleDescriptor as LoopbackModuleDescriptor, ModuleId as LoopbackModuleId,
        Request, RequestHead, Response, RouteDescriptor, RouteFuture, RouteHeadPlan,
    },
    module::{
        CapabilityCatalogSnapshot, CapabilityDescribeOutcome, CapabilityKey, EffectKind,
        ModuleDescriptor as PlatformModuleDescriptor, ModuleId as PlatformModuleId,
    },
};
use runtime_directory::{RuntimeCapabilitySurface, RuntimeDriverIdentity};
use serde_json::{Map, Value, json};

use crate::control::{CommandInput, CommandOutcome, CommandResult, RejectionCode};

use super::CapabilityVerifier;

const INVALID_INPUT_MESSAGE: &str = "Runtime Host command input is invalid.";
const UNKNOWN_CAPABILITY_MESSAGE: &str = "Capability descriptor is not available.";
const INVALID_SCOPE_MESSAGE: &str = "Capability scope is invalid.";
const SCOPE_NOT_AVAILABLE_MESSAGE: &str = "Capability scope is not available.";
const MODULE_ID: PlatformModuleId = PlatformModuleId::new("capability-catalog");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("capability.catalog")];
const REQUIRES: &[CapabilityKey] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::Route];
const ROUTES: &[&str] = &["capability-catalog.loopback"];
const EVENTS: &[&str] = &[];
const MAX_DESCRIBE_BYTES: usize = 64 * 1024;
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const CAPABILITIES_LIST_PATH: &str = "/api/capabilities/list";
const CAPABILITIES_DESCRIBE_PATH: &str = "/api/capabilities/describe";
const CAPABILITY_CATALOG_SCOPE: &str = "capability-directory:read";
const CAPABILITY_CATALOG_LIST_CAPABILITY: &str = "capability.directory.list";
const CAPABILITY_CATALOG_DESCRIBE_CAPABILITY: &str = "capability.directory.describe";
const CAPABILITY_CATALOG_SUBJECT: &str = "capability-directory";

#[derive(Clone)]
pub(crate) struct CapabilityCatalog {
    catalog: Arc<OnceLock<CapabilityCatalogSnapshot>>,
}

impl CapabilityCatalog {
    pub(crate) fn new() -> Self {
        Self {
            catalog: Arc::new(OnceLock::new()),
        }
    }

    pub(crate) fn descriptor(&self, verifier: CapabilityVerifier) -> PlatformModuleDescriptor {
        PlatformModuleDescriptor::new(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(self.loopback_descriptor(verifier)),
        )
    }

    pub(crate) fn install_snapshot(&self, snapshot: CapabilityCatalogSnapshot) {
        assert!(
            self.catalog.set(snapshot).is_ok(),
            "capability catalog installed once"
        );
    }

    pub(crate) fn list(&self) -> CommandOutcome {
        CommandOutcome::succeeded(CommandResult::public(self.list_projection()))
    }

    pub(crate) fn describe(&self, input: CommandInput) -> CommandOutcome {
        match self.describe_projection(input.into_value()) {
            DescribeProjection::Available(capability) => {
                CommandOutcome::succeeded(CommandResult::public(json!({
                    "capability": capability
                })))
            }
            DescribeProjection::InvalidInput(message) => {
                CommandOutcome::rejected(RejectionCode::InvalidInput, message)
            }
        }
    }

    fn list_projection(&self) -> Value {
        json!({ "capabilities": self.installed_catalog().installed_capabilities() })
    }

    fn describe_projection(&self, input: Value) -> DescribeProjection {
        let request: DescribeRequest = match serde_json::from_value::<DescribeRequest>(input) {
            Ok(request) if !is_identity_value(&Value::String(request.id.clone())) => {
                return DescribeProjection::InvalidInput(INVALID_INPUT_MESSAGE);
            }
            Ok(request) => request,
            Err(_) => return DescribeProjection::InvalidInput(INVALID_INPUT_MESSAGE),
        };

        if !is_runtime_scope(&request.scope) {
            return DescribeProjection::InvalidInput(INVALID_SCOPE_MESSAGE);
        }

        match self
            .installed_catalog()
            .describe_capability(&request.id, &request.scope)
        {
            CapabilityDescribeOutcome::Available(descriptor)
                if capability_supported_for_scope(&request.id, &request.scope) =>
            {
                DescribeProjection::Available(descriptor)
            }
            CapabilityDescribeOutcome::Available(_)
            | CapabilityDescribeOutcome::ScopeNotAvailable => {
                DescribeProjection::InvalidInput(SCOPE_NOT_AVAILABLE_MESSAGE)
            }
            CapabilityDescribeOutcome::UnknownCapability => {
                DescribeProjection::InvalidInput(UNKNOWN_CAPABILITY_MESSAGE)
            }
        }
    }

    fn loopback_descriptor(&self, verifier: CapabilityVerifier) -> LoopbackModuleDescriptor {
        let catalog = self.clone();
        LoopbackModuleDescriptor::new(
            LoopbackModuleId::new("capability-catalog"),
            vec![RouteDescriptor::bound(
                "capability-catalog.loopback",
                head_plan,
                move |request| route(catalog.clone(), Arc::clone(&verifier), request),
            )],
        )
    }

    fn installed_catalog(&self) -> &CapabilityCatalogSnapshot {
        self.catalog
            .get()
            .expect("capability catalog installed before serving routes")
    }
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    if path != CAPABILITIES_LIST_PATH && path != CAPABILITIES_DESCRIBE_PATH {
        return None;
    }
    let body_policy = match (head.method.as_str(), path) {
        ("GET", CAPABILITIES_LIST_PATH) => BodyPolicy::Empty,
        ("POST", CAPABILITIES_DESCRIBE_PATH) => BodyPolicy::Required {
            max_bytes: MAX_DESCRIBE_BYTES,
        },
        _ => BodyPolicy::Optional {
            max_bytes: MAX_DESCRIBE_BYTES,
        },
    };
    Some(RouteHeadPlan::new(
        body_policy,
        REQUEST_DEADLINE,
        timeout_response,
    ))
}

fn route(
    catalog: CapabilityCatalog,
    verifier: CapabilityVerifier,
    request: Request,
) -> RouteFuture {
    Box::pin(async move { handle_loopback(catalog, verifier, request).await.into() })
}

async fn handle_loopback(
    catalog: CapabilityCatalog,
    verifier: CapabilityVerifier,
    request: Request,
) -> Response {
    match (request.method(), pathname(request.path())) {
        ("GET", CAPABILITIES_LIST_PATH) => handle_list(catalog, verifier, &request).await,
        ("POST", CAPABILITIES_DESCRIBE_PATH) => handle_describe(catalog, verifier, request).await,
        _ => Response::not_found(),
    }
}

async fn handle_list(
    catalog: CapabilityCatalog,
    verifier: CapabilityVerifier,
    request: &Request,
) -> Response {
    if !authorize(
        verifier,
        request,
        CAPABILITIES_LIST_PATH,
        CAPABILITY_CATALOG_LIST_CAPABILITY,
    )
    .await
    {
        return unauthorized();
    }
    Response::json(200, catalog.list_projection())
}

async fn handle_describe(
    catalog: CapabilityCatalog,
    verifier: CapabilityVerifier,
    request: Request,
) -> Response {
    if !authorize(
        verifier,
        &request,
        CAPABILITIES_DESCRIBE_PATH,
        CAPABILITY_CATALOG_DESCRIBE_CAPABILITY,
    )
    .await
    {
        return unauthorized();
    }
    let input = match serde_json::from_slice::<Value>(&request.body) {
        Ok(input) => input,
        Err(_) => return Response::json(404, capability_not_available()),
    };
    match catalog.describe_projection(input) {
        DescribeProjection::Available(capability) => {
            Response::json(200, json!({ "capability": capability }))
        }
        DescribeProjection::InvalidInput(_) => Response::json(404, capability_not_available()),
    }
}

async fn authorize(
    verifier: CapabilityVerifier,
    request: &Request,
    endpoint: &'static str,
    capability: &'static str,
) -> bool {
    let Some(authorization) = request.bearer_authorization() else {
        return false;
    };
    let mut verifier = verifier.lock().await;
    verifier
        .verify(
            authorization,
            now_millis(),
            endpoint,
            CAPABILITY_CATALOG_SCOPE,
            capability,
            CAPABILITY_CATALOG_SUBJECT,
        )
        .is_ok()
}

fn timeout_response() -> Response {
    Response::json(
        503,
        json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}

fn unauthorized() -> Response {
    Response::error(401, "Capability directory authorization is invalid")
}

fn capability_not_available() -> Value {
    json!({ "success": false, "error": "Capability is not available" })
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DescribeRequest {
    id: String,
    scope: Value,
}

enum DescribeProjection {
    Available(Value),
    InvalidInput(&'static str),
}

fn capability_supported_for_scope(id: &str, scope: &Value) -> bool {
    let Some(identity) = runtime_identity_for_scope(scope) else {
        return true;
    };
    RuntimeCapabilitySurface::for_identity(identity)
        .availability_for_descriptor(id)
        .is_none_or(|availability| availability.is_supported())
}

fn runtime_identity_for_scope(scope: &Value) -> Option<RuntimeDriverIdentity> {
    match scope.get("kind").and_then(Value::as_str)? {
        "runtime-instance" | "agent" | "workspace" | "team-run" => {
            runtime_identity_for_endpoint(scope.get("endpoint")?)
        }
        "session" => runtime_identity_for_endpoint(scope.get("identity")?.get("endpoint")?),
        _ => None,
    }
}

fn runtime_identity_for_endpoint(endpoint: &Value) -> Option<RuntimeDriverIdentity> {
    let object = endpoint.as_object()?;
    if object.get("kind").and_then(Value::as_str)? != "native-runtime" {
        return None;
    }
    let adapter = object.get("runtimeAdapterId").and_then(Value::as_str)?;
    let instance = object.get("runtimeInstanceId").and_then(Value::as_str)?;
    for identity in [
        RuntimeDriverIdentity::open_claw(),
        RuntimeDriverIdentity::matcha_agent(),
    ] {
        if adapter == identity.runtime_adapter_id() && instance == identity.runtime_instance_id() {
            return Some(identity);
        }
    }
    None
}

fn is_runtime_scope(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(kind) = object.get("kind").and_then(Value::as_str) else {
        return false;
    };
    match kind {
        "app" | "provider-routing" => has_exact_keys(object, &["kind"]),
        "runtime-instance" => {
            has_exact_keys(object, &["kind", "endpoint"])
                && object.get("endpoint").is_some_and(is_runtime_endpoint)
        }
        "agent" => {
            has_exact_keys(object, &["kind", "endpoint", "agentId"])
                && object.get("endpoint").is_some_and(is_runtime_endpoint)
                && object.get("agentId").is_some_and(is_identity_value)
        }
        "session" => {
            has_exact_keys(object, &["kind", "identity"])
                && object.get("identity").is_some_and(is_session_identity)
        }
        "workspace" => {
            has_only_keys(object, &["kind", "endpoint", "workspaceId", "sourceId"])
                && object.get("endpoint").is_some_and(is_runtime_endpoint)
                && optional_identity(object, "workspaceId")
                && optional_identity(object, "sourceId")
        }
        "team-run" => {
            has_only_keys(object, &["kind", "endpoint", "runId", "teamId"])
                && object.get("endpoint").is_some_and(is_runtime_endpoint)
                && object.get("runId").is_some_and(is_identity_value)
                && optional_identity(object, "teamId")
        }
        _ => false,
    }
}

fn is_runtime_endpoint(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("native-runtime") => {
            has_exact_keys(object, &["kind", "runtimeAdapterId", "runtimeInstanceId"])
                && object
                    .get("runtimeAdapterId")
                    .is_some_and(is_identity_value)
                && object
                    .get("runtimeInstanceId")
                    .is_some_and(is_identity_value)
        }
        Some("protocol-connector") => {
            has_exact_keys(object, &["kind", "protocolId", "connectorId", "endpointId"])
                && object.get("protocolId").is_some_and(is_identity_value)
                && object.get("connectorId").is_some_and(is_identity_value)
                && object.get("endpointId").is_some_and(is_identity_value)
        }
        _ => false,
    }
}

fn is_session_identity(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    has_exact_keys(object, &["endpoint", "agentId", "sessionKey"])
        && object.get("endpoint").is_some_and(is_runtime_endpoint)
        && object.get("agentId").is_some_and(is_identity_value)
        && object.get("sessionKey").is_some_and(is_identity_value)
}

fn optional_identity(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).is_none_or(is_identity_value)
}

fn is_identity_value(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| !value.trim().is_empty() && !value.contains('\0'))
}

fn has_exact_keys(object: &Map<String, Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn has_only_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}
