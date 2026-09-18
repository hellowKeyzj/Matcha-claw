use serde::Deserialize;
use serde_json::Value;

use platform::endpoint::runtime_address::{RuntimeEndpoint, SessionIdentity};

use crate::{
    sessions::openclaw_direct::SessionCatalog,
    transport::{
        common::authorization::CapabilityDecisionVerifier,
        sessions::key::{is_cron_session_key, is_main_session_key},
    },
};

pub(crate) mod abort;
pub(crate) mod approval;
mod content;
pub(crate) mod create;
pub(crate) mod delete;
pub(crate) mod events;
pub(crate) mod handler;
pub(crate) mod key;
pub(crate) mod matcha_catalog;
pub(crate) mod matcha_history;
pub(crate) mod model_selection;
pub(crate) mod permission;
pub(crate) mod presenter;
mod rename;
pub(crate) mod send;
mod timeline;
pub(crate) mod trace;

const CAPABILITY_ID: &str = "session.management";
const OPERATION_ID: &str = "sessions.list";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_ADAPTER_ID: &str = "openclaw";
const RUNTIME_INSTANCE_ID: &str = "local";
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
            && self.scope.endpoint.is_openclaw_local())
        .then_some(())
        .ok_or(RequestError::Invalid)
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
    fn is_openclaw_local(&self) -> bool {
        self.kind == RUNTIME_KIND
            && self.runtime_adapter_id == RUNTIME_ADAPTER_ID
            && self.runtime_instance_id == RUNTIME_INSTANCE_ID
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
    updated_at: Option<u64>,
}

fn session_value(session: &Session) -> Value {
    let mut value = serde_json::json!({
        "key": &session.key,
        "agentId": &session.agent_id,
        "sessionIdentity": session_identity_value(session),
        "kind": public_session_kind_value(session.kind),
        "endpointSessionId": &session.endpoint_session_id,
    });
    if let Some(updated_at) = session.updated_at {
        value["updatedAt"] = serde_json::json!(updated_at);
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

fn project_session(
    session: crate::sessions::openclaw_direct::SessionCatalogEntry,
) -> Option<Session> {
    let kind = public_session_kind(&session.key);
    Some(Session {
        session_identity: SessionIdentity::try_new(
            openclaw_local_endpoint(),
            session.agent_id.clone(),
            session.key.clone(),
        )
        .ok()?,
        key: session.key,
        agent_id: session.agent_id,
        kind,
        endpoint_session_id: session.endpoint_session_id,
        updated_at: session.updated_at,
    })
}

fn openclaw_local_endpoint() -> RuntimeEndpoint {
    RuntimeEndpoint::try_new(RUNTIME_ADAPTER_ID, RUNTIME_INSTANCE_ID)
        .expect("fixed OpenClaw endpoint must be a valid runtime address")
}

pub(crate) fn map_catalog_outcome<E>(
    result: Result<SessionCatalog, crate::RuntimeSessionError<E>>,
) -> SessionListDelivery {
    match result {
        Ok(result) => {
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
        Err(_) => SessionListDelivery::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::sessions::openclaw_direct::SessionCatalogEntry;

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
    fn accepts_only_the_fixed_openclaw_local_session_list_request() {
        assert_eq!(
            SessionListRequest::decode_semantics(request()).unwrap().id,
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
                value["scope"]["endpoint"]["runtimeInstanceId"] = json!("remote");
                value
            },
            {
                let mut value = request();
                value["input"]["endpoint"]["runtimeAdapterId"] = json!("other");
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
        let (agent_id, endpoint_session_id) = {
            let (agent_id, endpoint_session_id) = key
                .strip_prefix("agent:")
                .and_then(|value| value.split_once(':'))
                .expect("test catalog entries must be agent-scoped");
            (agent_id.to_owned(), endpoint_session_id.to_owned())
        };
        SessionCatalogEntry {
            key,
            agent_id,
            endpoint_session_id,
            updated_at,
        }
    }

    fn catalog_result(sessions: Vec<SessionCatalogEntry>) -> SessionListDelivery {
        map_catalog_outcome::<()>(Ok(SessionCatalog { sessions }))
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
    fn redacts_non_public_catalog_metadata() {
        let mut entry = catalog_entry("agent:main:direct-session");
        entry.updated_at = None;
        let projected = catalog_result(vec![entry]).body();
        assert!(projected["sessions"][0].get("updatedAt").is_none());
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
            "preferred",
        ] {
            assert!(!rendered.contains(private));
        }
    }

    #[test]
    fn catalog_unavailable_and_failure_have_one_fixed_public_outcome() {
        let unavailable =
            map_catalog_outcome::<()>(Err(crate::RuntimeSessionError::RuntimeUnavailable));
        let failure = map_catalog_outcome(Err(crate::RuntimeSessionError::Client(
            "private catalog failure",
        )));

        let expected = json!({
            "success": false,
            "error": "Session catalog is unavailable",
        });
        assert_eq!(unavailable.status_code(), 503);
        assert_eq!(failure.status_code(), 503);
        assert_eq!(unavailable.body(), expected);
        assert_eq!(failure.body(), expected);
        assert!(
            !failure
                .body()
                .to_string()
                .contains("private catalog failure")
        );
    }
}
