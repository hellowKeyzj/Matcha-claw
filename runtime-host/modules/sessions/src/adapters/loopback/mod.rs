use platform::{
    capability::CapabilityDecisionVerifier,
    endpoint::runtime_address::{RuntimeEndpoint, SessionIdentity},
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan, RouteOutcome, StreamResponse,
    },
};

use serde::Deserialize;
use serde_json::Value;

use std::{sync::Arc, time::Duration};

use tokio::sync::Mutex;

use crate::{
    adapters::loopback::key::{is_cron_session_key, is_main_session_key},
    events::SessionDeltaStream,
    send_hook::SessionSendHookSet,
    session_catalog::{SessionCatalogCommand, SessionCatalogEntry, SessionCatalogOutcome},
    state::SessionModelState,
};

pub(crate) mod abort;
pub(crate) mod approval;
mod content;
pub(crate) mod create;
pub(crate) mod delete;
pub(crate) mod events;
pub(crate) mod handler;
pub(crate) mod history;
pub(crate) mod key;
pub(crate) mod model_selection;
pub(crate) mod permission;
pub(crate) mod presenter;
mod rename;
pub(crate) mod send;
mod timeline;
pub mod trace;

pub use events::{Action as SessionEventsAction, EventStream as SessionEventsStream};

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const SESSIONS_REQUEST_BYTES: usize =
    (20_usize * 1024 * 1024).div_ceil(3) * 4 + 64 * 1024 + 128 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
    send_hooks: SessionSendHookSet,
    session_delta_source: crate::SessionDeltaSource,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        session: crate::SessionHandle,
        send_hooks: SessionSendHookSet,
        session_delta_source: crate::SessionDeltaSource,
    ) -> Self {
        Self {
            verifier,
            session,
            send_hooks,
            session_delta_source,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("sessions"),
        vec![
            RouteDescriptor::bound("sessions.loopback", head_plan, {
                let dependencies = dependencies.clone();
                move |request| route(dependencies.clone(), request)
            }),
            RouteDescriptor::bound("sessions.events", events::head_plan, move |request| {
                route_events(dependencies.clone(), request)
            }),
        ],
    )
}

pub fn events_head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    events::head_plan(head)
}

pub async fn handle_events(
    request: &Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    source: crate::SessionDeltaSource,
) -> Option<SessionEventsAction> {
    events::handle(request, verifier, source).await
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    is_session_route(path).then(|| {
        RouteHeadPlan::new(
            body_policy_for_method(head.method.as_str(), SESSIONS_REQUEST_BYTES),
            DEFAULT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        let response = handler::handle_loopback(
            &request,
            Arc::clone(&dependencies.verifier),
            dependencies.session,
            dependencies.send_hooks,
        )
        .await;
        response.unwrap_or_else(Response::not_found).into()
    })
}

fn route_events(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        match events::handle(
            &request,
            Arc::clone(&dependencies.verifier),
            dependencies.session_delta_source,
        )
        .await
        {
            Some(events::Action::Response(response)) => response.into(),
            Some(events::Action::Stream(stream)) => {
                let (receiver, keepalive_interval) = stream.into_parts();
                RouteOutcome::Stream(StreamResponse::owned(SessionDeltaStream::new(
                    receiver,
                    keepalive_interval,
                )))
            }
            None => Response::not_found().into(),
        }
    })
}

fn body_policy_for_method(method: &str, max_bytes: usize) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else if method == "POST" {
        BodyPolicy::Required { max_bytes }
    } else {
        BodyPolicy::Optional {
            max_bytes: DEFAULT_REQUEST_BYTES,
        }
    }
}

fn timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}

fn is_session_route(path: &str) -> bool {
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

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

const CAPABILITY_ID: &str = "session.management";
const OPERATION_ID: &str = "sessions.list";
const RUNTIME_KIND: &str = "native-runtime";
const SCOPE_KIND: &str = "runtime-instance";
const TARGET_KIND: &str = "runtime-endpoint";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions";
const AUTHORIZATION_SCOPE: &str = "sessions:read";
const AUTHORIZATION_SUBJECT: &str = "session-catalog";
pub(crate) const MAX_SESSIONS: usize = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SessionListRequest {
    id: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl SessionListRequest {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        Self::decode_semantics(value).map_err(|_| DecodeError::Invalid)
    }

    fn decode_semantics(value: Value) -> Result<Self, RequestError> {
        let request: Self = serde_json::from_value(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), RequestError> {
        (self.id == CAPABILITY_ID
            && self.operation_id == OPERATION_ID
            && self.scope.kind == SCOPE_KIND
            && self.target.kind == TARGET_KIND
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.runtime_endpoint().is_some())
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(self) -> Option<SessionCatalogCommand> {
        self.input
            .endpoint
            .runtime_endpoint()
            .map(SessionCatalogCommand::new)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Scope {
    kind: String,
    endpoint: Endpoint,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Input {
    endpoint: Endpoint,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    #[serde(rename = "runtimeAdapterId")]
    runtime_adapter_id: String,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: String,
}

impl Endpoint {
    fn runtime_endpoint(&self) -> Option<RuntimeEndpoint> {
        (self.kind == RUNTIME_KIND).then(|| {
            RuntimeEndpoint::try_new(
                self.runtime_adapter_id.as_str(),
                self.runtime_instance_id.as_str(),
            )
            .ok()
        })?
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionListDelivery {
    Ok(SessionListResponse),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionListResponse {
    sessions: Vec<Session>,
}

impl SessionListDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Ok(response) => serde_json::json!({
                "sessions": response.sessions.iter().map(session_value).collect::<Vec<_>>(),
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session catalog is unavailable",
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublicSessionKind {
    Main,
    Session,
    Automation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Session {
    key: String,
    agent_id: String,
    session_identity: SessionIdentity,
    kind: PublicSessionKind,
    endpoint_session_id: String,
    model_state: Option<SessionModelState>,
    updated_at: Option<u64>,
    preferred: Option<bool>,
    protocol_id: Option<String>,
    runtime_endpoint_id: Option<String>,
}

fn session_value(session: &Session) -> Value {
    let mut value = serde_json::json!({
        "key": &session.key,
        "agentId": &session.agent_id,
        "sessionIdentity": session_identity_value(session),
        "kind": public_session_kind_value(session.kind),
        "endpointSessionId": &session.endpoint_session_id,
    });
    if let Some(model_state) = &session.model_state {
        value["modelState"] = serde_json::json!(model_state);
    }
    if let Some(updated_at) = session.updated_at {
        value["updatedAt"] = serde_json::json!(updated_at);
    }
    if let Some(preferred) = session.preferred {
        value["preferred"] = serde_json::json!(preferred);
    }
    if let Some(protocol_id) = &session.protocol_id {
        value["protocolId"] = serde_json::json!(protocol_id);
    }
    if let Some(runtime_endpoint_id) = &session.runtime_endpoint_id {
        value["runtimeEndpointId"] = serde_json::json!(runtime_endpoint_id);
    }
    value
}

fn session_identity_value(session: &Session) -> Value {
    serde_json::json!({
        "endpoint": runtime_endpoint_value(session.session_identity.endpoint()),
        "agentId": &session.agent_id,
        "sessionKey": &session.key,
    })
}

fn runtime_endpoint_value(endpoint: &RuntimeEndpoint) -> Value {
    serde_json::json!({
        "kind": "native-runtime",
        "runtimeAdapterId": endpoint.runtime_adapter_id(),
        "runtimeInstanceId": endpoint.runtime_instance_id(),
    })
}

fn public_session_kind_value(kind: PublicSessionKind) -> &'static str {
    match kind {
        PublicSessionKind::Main => "main",
        PublicSessionKind::Session => "session",
        PublicSessionKind::Automation => "automation",
    }
}

fn public_session_kind(session_key: &str) -> PublicSessionKind {
    if is_main_session_key(session_key) {
        PublicSessionKind::Main
    } else if is_cron_session_key(session_key) {
        PublicSessionKind::Automation
    } else {
        PublicSessionKind::Session
    }
}

fn project_session(session: SessionCatalogEntry) -> Option<Session> {
    let kind = public_session_kind(&session.key);
    Some(Session {
        session_identity: SessionIdentity::try_new(
            session.endpoint.clone(),
            session.agent_id.clone(),
            session.key.clone(),
        )
        .ok()?,
        key: session.key,
        agent_id: session.agent_id,
        kind,
        endpoint_session_id: session.endpoint_session_id,
        model_state: session.model_state,
        updated_at: session.updated_at,
        preferred: session.preferred,
        protocol_id: session.protocol_id,
        runtime_endpoint_id: session.runtime_endpoint_id,
    })
}

pub(crate) fn map_catalog_outcome(result: SessionCatalogOutcome) -> SessionListDelivery {
    match result {
        SessionCatalogOutcome::Listed(result) => {
            let mut sessions: Vec<_> = result
                .sessions
                .into_iter()
                .filter_map(project_session)
                .collect();
            sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            SessionListDelivery::Ok(SessionListResponse {
                sessions: sessions.into_iter().take(MAX_SESSIONS).collect(),
            })
        }
        SessionCatalogOutcome::Unavailable => SessionListDelivery::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::session_catalog::SessionCatalog;

    fn request() -> Value {
        json!({
            "id": "session.management",
            "operationId": "sessions.list",
            "scope": {
                "kind": "runtime-instance",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
            },
            "target": { "kind": "runtime-endpoint" },
            "input": {
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
            },
        })
    }

    #[test]
    fn accepts_well_formed_native_runtime_session_list_request() {
        assert_eq!(
            SessionListRequest::decode_semantics(request()).unwrap().id,
            CAPABILITY_ID
        );

        let mut matcha = request();
        matcha["scope"]["endpoint"]["runtimeAdapterId"] = json!("matcha-agent");
        matcha["input"]["endpoint"]["runtimeAdapterId"] = json!("matcha-agent");
        assert_eq!(
            SessionListRequest::decode_semantics(matcha).unwrap().id,
            CAPABILITY_ID
        );

        for value in [
            json!({}),
            json!({
                "id": "session.management",
                "operationId": "sessions.list",
                "scope": { "kind": "runtime-instance", "endpoint": {} },
                "target": { "kind": "runtime-endpoint" },
                "input": { "endpoint": {} },
            }),
            {
                let mut value = request();
                value["input"]["limit"] = json!(1);
                value
            },
            {
                let mut value = request();
                value["input"]["endpoint"]["token"] = json!("private-token");
                value
            },
            {
                let mut value = request();
                value["peerSensitiveField"] = json!("private-peer-value");
                value
            },
        ] {
            assert_eq!(
                SessionListRequest::decode_semantics(value),
                Err(RequestError::Invalid)
            );
        }
    }

    fn catalog_entry(key: impl Into<String>) -> SessionCatalogEntry {
        catalog_entry_at(key, Some(42))
    }

    fn catalog_entry_at(key: impl Into<String>, updated_at: Option<u64>) -> SessionCatalogEntry {
        let key = key.into();
        let (agent_id, endpoint_session_id) = if let Some((agent_id, endpoint_session_id)) = key
            .strip_prefix("agent:")
            .and_then(|value| value.split_once(':'))
        {
            (agent_id.to_owned(), endpoint_session_id.to_owned())
        } else {
            let mut parts = key.splitn(3, ':');
            let _adapter = parts
                .next()
                .expect("test catalog entries must name an adapter");
            let agent_id = parts
                .next()
                .expect("test catalog entries must name an agent");
            let endpoint_session_id = parts
                .next()
                .expect("test catalog entries must name a native session");
            (agent_id.to_owned(), endpoint_session_id.to_owned())
        };
        SessionCatalogEntry {
            endpoint: RuntimeEndpoint::try_new("openclaw", "local").unwrap(),
            key,
            agent_id,
            endpoint_session_id,
            model_state: None,
            updated_at,
            preferred: None,
            protocol_id: None,
            runtime_endpoint_id: None,
        }
    }

    fn catalog_result(sessions: Vec<SessionCatalogEntry>) -> SessionListDelivery {
        map_catalog_outcome(SessionCatalogOutcome::Listed(SessionCatalog { sessions }))
    }

    #[test]
    fn projects_an_agent_scoped_catalog_session_without_private_metadata() {
        let response = catalog_result(vec![catalog_entry("agent:main:direct-session")]);

        assert_eq!(response.status_code(), 200);
        assert_eq!(
            response.body(),
            json!({
                "sessions": [{
                    "key": "agent:main:direct-session",
                    "agentId": "main",
                    "sessionIdentity": {
                        "endpoint": {
                            "kind": "native-runtime",
                            "runtimeAdapterId": "openclaw",
                            "runtimeInstanceId": "local",
                        },
                        "agentId": "main",
                        "sessionKey": "agent:main:direct-session",
                    },
                    "kind": "session",
                    "endpointSessionId": "direct-session",
                    "updatedAt": 42,
                }],
            })
        );
    }

    #[test]
    fn projects_catalog_session_ids() {
        let response = catalog_result(vec![
            catalog_entry("agent:main:main"),
            catalog_entry("agent:worker:direct-session"),
        ]);

        assert_eq!(
            response.body(),
            json!({
                "sessions": [
                    {
                        "key": "agent:main:main",
                        "agentId": "main",
                        "sessionIdentity": {
                            "endpoint": {
                                "kind": "native-runtime",
                                "runtimeAdapterId": "openclaw",
                                "runtimeInstanceId": "local",
                            },
                            "agentId": "main",
                            "sessionKey": "agent:main:main",
                        },
                        "kind": "main",
                        "endpointSessionId": "main",
                        "updatedAt": 42,
                    },
                    {
                        "key": "agent:worker:direct-session",
                        "agentId": "worker",
                        "sessionIdentity": {
                            "endpoint": {
                                "kind": "native-runtime",
                                "runtimeAdapterId": "openclaw",
                                "runtimeInstanceId": "local",
                            },
                            "agentId": "worker",
                            "sessionKey": "agent:worker:direct-session",
                        },
                        "kind": "session",
                        "endpointSessionId": "direct-session",
                        "updatedAt": 42,
                    }
                ],
            })
        );
    }

    #[test]
    fn projects_multiple_agents_and_protocol_key_shapes() {
        let response = catalog_result(vec![
            catalog_entry("agent:main:main"),
            catalog_entry("agent:worker:subagent:run-7"),
        ]);

        let sessions = response.body()["sessions"].as_array().unwrap().clone();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0]["agentId"], "main");
        assert_eq!(
            sessions[0]["sessionIdentity"]["agentId"],
            sessions[0]["agentId"]
        );
        assert_eq!(
            sessions[0]["sessionIdentity"]["sessionKey"],
            sessions[0]["key"]
        );
        assert_eq!(
            sessions[0]["sessionIdentity"]["endpoint"],
            json!({
                "kind": "native-runtime",
                "runtimeAdapterId": "openclaw",
                "runtimeInstanceId": "local",
            })
        );
        assert_eq!(sessions[1]["agentId"], "worker");
        assert_eq!(
            sessions[1]["sessionIdentity"]["agentId"],
            sessions[1]["agentId"]
        );
        assert_eq!(
            sessions[1]["sessionIdentity"]["sessionKey"],
            sessions[1]["key"]
        );
    }

    #[test]
    fn projects_cron_session_keys_as_automation_kind() {
        let response = catalog_result(vec![
            catalog_entry("agent:worker:cron:daily"),
            catalog_entry("agent:worker:cron:daily:run:run-7"),
            catalog_entry("agent:worker:cron:nightly"),
        ]);

        let sessions = response.body()["sessions"].as_array().unwrap().clone();
        assert_eq!(sessions.len(), 3);
        for session in sessions {
            assert_eq!(session["kind"], "automation");
        }
    }

    #[test]
    fn does_not_project_regular_sessions_as_automation() {
        let response = catalog_result(vec![
            catalog_entry("agent:worker:direct-session"),
            catalog_entry("agent:worker:subagent:cron:daily"),
            catalog_entry("agent:worker:direct:cron:daily"),
        ]);

        let sessions = response.body()["sessions"].as_array().unwrap().clone();
        assert_eq!(sessions.len(), 3);
        for session in sessions {
            assert_eq!(session["kind"], "session");
        }
    }

    #[test]
    fn rejects_malformed_cron_session_keys_without_opening_automation_kind() {
        let response = catalog_result(vec![
            catalog_entry("agent:worker:cron"),
            catalog_entry("agent:worker:cron:daily:run"),
            catalog_entry("agent:worker:cron:daily:run:run-7:extra"),
            catalog_entry("agent:worker:cron"),
            catalog_entry("agent:worker:cron:nightly:extra"),
        ]);

        let sessions = response.body()["sessions"].as_array().unwrap().clone();
        assert_eq!(sessions.len(), 5);
        for session in sessions {
            assert_eq!(session["kind"], "session");
        }
    }

    #[test]
    fn omits_catalog_entries_with_invalid_public_session_identity() {
        let mut invalid = catalog_entry("agent:main:main");
        invalid.agent_id = String::new();
        let response = catalog_result(vec![invalid, catalog_entry("agent:main:valid")]);

        let body = response.body();
        let sessions = body["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["key"], "agent:main:valid");
        assert_eq!(sessions[0]["agentId"], "main");
    }

    #[test]
    fn sorts_projected_sessions_by_updated_at_before_applying_bounded_limit() {
        let sessions = vec![
            catalog_entry_at("agent:main:old", Some(1)),
            catalog_entry_at("agent:worker:new", Some(30)),
            catalog_entry_at("agent:main:newest", Some(40)),
            catalog_entry_at("agent:worker:unknown-time", None),
            catalog_entry_at("agent:main:middle", Some(20)),
        ];
        let projected = catalog_result(sessions).body();

        let sessions = projected["sessions"].as_array().unwrap();
        assert_eq!(
            sessions
                .iter()
                .map(|session| session["key"].as_str())
                .collect::<Vec<_>>(),
            vec![
                Some("agent:main:newest"),
                Some("agent:worker:new"),
                Some("agent:main:middle"),
                Some("agent:main:old"),
                Some("agent:worker:unknown-time"),
            ]
        );
    }

    #[test]
    fn limits_successfully_projected_sessions_after_sorting_and_omitting_unowned_rows() {
        let sessions = (0..=MAX_SESSIONS)
            .map(|index| {
                catalog_entry_at(format!("agent:main:session-{index}"), Some(index as u64))
            })
            .collect();
        let projected = catalog_result(sessions).body();

        let sessions = projected["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), MAX_SESSIONS);
        assert_eq!(sessions[0]["key"], "agent:main:session-100");
        assert_eq!(
            sessions[MAX_SESSIONS - 1]["key"],
            format!("agent:main:session-1")
        );
    }

    #[test]
    fn projects_public_runtime_catalog_metadata() {
        let mut entry = catalog_entry("matcha-agent:matcha:direct-session");
        entry.endpoint = RuntimeEndpoint::try_new("matcha-agent", "local").unwrap();
        entry.agent_id = "matcha".to_owned();
        entry.endpoint_session_id = "direct-session".to_owned();
        entry.preferred = Some(false);
        entry.protocol_id = Some("matcha-agent-app-server".to_owned());
        entry.runtime_endpoint_id = Some("matcha-agent-local".to_owned());

        let projected = catalog_result(vec![entry]).body();
        assert_eq!(projected["sessions"][0]["preferred"], false);
        assert_eq!(
            projected["sessions"][0]["protocolId"],
            "matcha-agent-app-server"
        );
        assert_eq!(
            projected["sessions"][0]["runtimeEndpointId"],
            "matcha-agent-local"
        );
    }

    #[test]
    fn redacts_non_public_catalog_metadata() {
        let mut entry = catalog_entry("agent:main:direct-session");
        entry.updated_at = None;
        let projected = catalog_result(vec![entry]).body();
        assert!(projected["sessions"][0].get("updatedAt").is_none());
        assert!(projected["sessions"][0].get("preferred").is_none());
        assert!(projected["sessions"][0].get("protocolId").is_none());
        assert!(projected["sessions"][0].get("runtimeEndpointId").is_none());
        assert!(projected.get("timestamp").is_none());
        assert!(projected.get("count").is_none());
        let rendered = projected.to_string();

        for private in [
            "private-label",
            "private-display",
            "private-title",
            "private-model",
            "status",
            "hasActiveRun",
            "timestamp",
            "totalCount",
            "limitApplied",
            "hasMore",
            "ready",
            "refreshing",
            "error",
        ] {
            assert!(!rendered.contains(private));
        }
    }

    #[test]
    fn catalog_unavailable_has_one_fixed_public_outcome() {
        let unavailable = map_catalog_outcome(SessionCatalogOutcome::Unavailable);

        let expected = json!({
            "success": false,
            "error": "Session catalog is unavailable",
        });
        assert_eq!(unavailable.status_code(), 503);
        assert_eq!(unavailable.body(), expected);
    }
}
