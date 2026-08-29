use serde::{Deserialize, Serialize};
use serde_json::Value;

use platform::endpoint::runtime_address::{RuntimeEndpoint, SessionIdentity};

use crate::{RuntimeSessionError, transport::authorization::CapabilityDecisionVerifier};

mod rename;
pub(crate) mod server;
mod timeline;

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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
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
            Self::Ok(response) => serde_json::to_value(response)
                .expect("Session list public response is serializable"),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session catalog is unavailable",
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum PublicSessionKind {
    Main,
    Session,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Session {
    key: String,
    agent_id: String,
    session_identity: SessionIdentity,
    kind: PublicSessionKind,
    endpoint_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<u64>,
}

fn public_session_kind(endpoint_session_id: &str) -> PublicSessionKind {
    if endpoint_session_id == "main" {
        PublicSessionKind::Main
    } else {
        PublicSessionKind::Session
    }
}

fn project_session(session: openclaw::session::protocol::SessionSummary) -> Option<Session> {
    let entry = session.agent_scoped_catalog_entry()?;
    let key = entry.session_key.as_str().to_owned();
    let agent_id = entry.agent_id.as_str().to_owned();
    let kind = public_session_kind(&entry.endpoint_session_id);
    Some(Session {
        session_identity: SessionIdentity::try_new(
            openclaw_local_endpoint(),
            agent_id.clone(),
            key.clone(),
        )
        .ok()?,
        key,
        agent_id,
        kind,
        endpoint_session_id: entry.endpoint_session_id,
        updated_at: session.updated_at,
    })
}

fn openclaw_local_endpoint() -> RuntimeEndpoint {
    RuntimeEndpoint::try_new(RUNTIME_ADAPTER_ID, RUNTIME_INSTANCE_ID)
        .expect("fixed OpenClaw endpoint must be a valid runtime address")
}

pub(crate) fn map_native_outcome<E>(
    result: Result<openclaw::session::protocol::SessionsListResult, RuntimeSessionError<E>>,
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
    use openclaw::session::protocol::SessionKind;

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

    fn summary(
        key: impl Into<String>,
        kind: openclaw::session::protocol::SessionKind,
    ) -> openclaw::session::protocol::SessionSummary {
        summary_for_agent(key, kind, None)
    }

    fn summary_for_agent(
        key: impl Into<String>,
        kind: openclaw::session::protocol::SessionKind,
        agent_id: Option<&str>,
    ) -> openclaw::session::protocol::SessionSummary {
        openclaw::session::protocol::SessionSummary {
            key: openclaw::session::protocol::SessionKey::try_new(key).unwrap(),
            kind,
            agent_id: agent_id
                .map(|agent_id| openclaw::session::protocol::AgentId::try_new(agent_id).unwrap()),
            label: Some("private-label".into()),
            display_name: Some("private-display".into()),
            derived_title: Some("private-title".into()),
            updated_at: Some(42),
            status: Some("idle".into()),
            has_active_run: Some(true),
            model: Some("private-model".into()),
        }
    }

    fn summary_at(
        key: impl Into<String>,
        kind: openclaw::session::protocol::SessionKind,
        updated_at: Option<u64>,
    ) -> openclaw::session::protocol::SessionSummary {
        let mut session = summary(key, kind);
        session.updated_at = updated_at;
        session
    }

    fn native_result(
        sessions: Vec<openclaw::session::protocol::SessionSummary>,
    ) -> SessionListDelivery {
        map_native_outcome::<()>(Ok(openclaw::session::protocol::SessionsListResult {
            timestamp_ms: 42,
            count: sessions.len() as u64,
            total_count: Some(sessions.len() as u64),
            limit_applied: Some(sessions.len() as u64),
            has_more: Some(true),
            sessions,
        }))
    }

    #[test]
    fn projects_an_agent_scoped_native_session_without_catalog_metadata() {
        let response = native_result(vec![summary(
            "agent:main:direct-session",
            SessionKind::Direct,
        )]);

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
    fn projects_native_session_ids_when_the_catalog_provides_agent_ownership() {
        let response = native_result(vec![
            summary("global", SessionKind::Global),
            summary("unknown", SessionKind::Unknown),
            summary_for_agent("main", SessionKind::Direct, Some("main")),
            summary("agent:worker:direct-session", SessionKind::Direct),
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
        let response = native_result(vec![
            summary("agent:main:main", SessionKind::Direct),
            summary("agent:worker:subagent:run-7", SessionKind::Group),
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
    fn rejects_malformed_agent_keys_without_opening_global_or_unknown_scope() {
        let response = native_result(vec![
            summary("global", SessionKind::Global),
            summary("unknown", SessionKind::Unknown),
            summary("agent", SessionKind::Direct),
            summary("agent::main", SessionKind::Direct),
            summary("agent:Main:main", SessionKind::Direct),
            summary("agent:main:", SessionKind::Direct),
            summary("agent:main:main::child", SessionKind::Direct),
            summary("agent:main:main", SessionKind::Direct),
        ]);

        let body = response.body();
        let sessions = body["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["key"], "agent:main:main");
        assert_eq!(sessions[0]["agentId"], "main");
    }

    #[test]
    fn sorts_projected_sessions_by_updated_at_before_applying_bounded_limit() {
        let sessions = vec![
            summary_at("agent:main:old", SessionKind::Direct, Some(1)),
            summary_at("global", SessionKind::Global, Some(10_000)),
            summary_at("agent:worker:new", SessionKind::Direct, Some(30)),
            summary_at("agent:main:newest", SessionKind::Direct, Some(40)),
            summary_at("agent:worker:unknown-time", SessionKind::Direct, None),
            summary_at("agent:main:middle", SessionKind::Direct, Some(20)),
        ];
        let projected = native_result(sessions).body();

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
        let sessions = std::iter::once(summary_at("global", SessionKind::Global, Some(100_000)))
            .chain((0..=MAX_SESSIONS).map(|index| {
                summary_at(
                    format!("agent:main:session-{index}"),
                    SessionKind::Direct,
                    Some(index as u64),
                )
            }))
            .collect();
        let projected = native_result(sessions).body();

        let sessions = projected["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), MAX_SESSIONS);
        assert_eq!(sessions[0]["key"], "agent:main:session-100");
        assert_eq!(
            sessions[MAX_SESSIONS - 1]["key"],
            format!("agent:main:session-1")
        );
    }

    #[test]
    fn redacts_native_catalog_fields_and_top_level_metadata() {
        let mut summary = summary("agent:main:direct-session", SessionKind::Direct);
        summary.updated_at = None;
        let projected = native_result(vec![summary]).body();
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
    fn native_unavailable_and_failure_have_one_fixed_public_outcome() {
        let unavailable = map_native_outcome::<()>(Err(RuntimeSessionError::RuntimeUnavailable));
        let failure =
            map_native_outcome(Err(RuntimeSessionError::Client("private native failure")));

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
                .contains("private native failure")
        );
    }
}
