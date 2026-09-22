use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    api::UsageHandle,
    domain::model::{UsageEntry as ModelUsageEntry, UsageReadError},
};

pub const RECENT_PATH: &str = "/api/usage/recent";
pub const SESSION_TIMESERIES_PATH: &str = "/api/usage/session-timeseries";
const AUTHORIZATION_SCOPE: &str = "openclaw:usage-history:read";
const AUTHORIZATION_CAPABILITY: &str = "openclaw.usage.history";
const AUTHORIZATION_SUBJECT: &str = "openclaw-usage-history";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    usage: UsageHandle,
}

impl Dependencies {
    pub fn new(verifier: Arc<Mutex<CapabilityDecisionVerifier>>, usage: UsageHandle) -> Self {
        Self { verifier, usage }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("usage"),
        vec![RouteDescriptor::bound(
            "usage.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    (head.method == "GET" && matches!(path, RECENT_PATH | SESSION_TIMESERIES_PATH))
        .then(|| RouteHeadPlan::new(BodyPolicy::Empty, DEFAULT_DEADLINE, timeout_response))
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move { handle(request, dependencies).await.into() })
}

async fn handle(request: Request, dependencies: Dependencies) -> Response {
    let parsed = RequestView::from_request(&request);
    if parsed.route == Route::Invalid {
        return response(ResponseBody::bad_request());
    }
    if request.method() != "GET"
        || !matches!(parsed.route, Route::Recent | Route::SessionTimeseries)
    {
        return Response::not_found();
    }
    let Some(authorization) = request
        .headers()
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return response(ResponseBody::unauthorized());
    };
    let mut verifier = dependencies.verifier.lock().await;
    if verifier
        .verify(
            authorization,
            now_millis(),
            RECENT_PATH,
            AUTHORIZATION_SCOPE,
            AUTHORIZATION_CAPABILITY,
            AUTHORIZATION_SUBJECT,
        )
        .is_err()
    {
        return response(ResponseBody::unauthorized());
    }
    drop(verifier);

    let result = match parsed.route {
        Route::Recent => {
            let limit = match decode_limit(
                parsed.limit.as_deref(),
                dependencies.usage.default_limit().await,
                dependencies.usage.max_limit().await,
            ) {
                Ok(limit) => limit,
                Err(()) => return response(ResponseBody::bad_request()),
            };
            dependencies.usage.recent(limit).await
        }
        Route::SessionTimeseries => {
            dependencies
                .usage
                .session_timeseries(parsed.agent_id, parsed.session_id)
                .await
        }
        Route::Unknown => return Response::not_found(),
        Route::Invalid => return response(ResponseBody::bad_request()),
    };
    response(UsageDelivery::from_result(result).into_response_body())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Route {
    Recent,
    SessionTimeseries,
    Unknown,
    Invalid,
}

struct RequestView {
    route: Route,
    limit: Option<String>,
    session_id: String,
    agent_id: String,
}

impl RequestView {
    fn from_request(request: &Request) -> Self {
        let (pathname, query) = request
            .path()
            .split_once('?')
            .map_or((request.path(), None), |(pathname, query)| {
                (pathname, Some(query))
            });
        match parse_query(pathname, query) {
            Ok(query) => query,
            Err(()) => Self {
                route: Route::Invalid,
                limit: Some(String::new()),
                session_id: String::new(),
                agent_id: String::new(),
            },
        }
    }
}

fn parse_query(pathname: &str, query: Option<&str>) -> Result<RequestView, ()> {
    let route = match pathname {
        RECENT_PATH => Route::Recent,
        SESSION_TIMESERIES_PATH => Route::SessionTimeseries,
        _ => Route::Unknown,
    };
    let mut limit = None;
    let mut session_id = None;
    let mut agent_id = None;
    if let Some(query) = query {
        for pair in query.split('&') {
            let Some((name, value)) = pair.split_once('=') else {
                return Err(());
            };
            let name = percent_decode_query_component(name).ok_or(())?;
            let value = percent_decode_query_component(value).ok_or(())?;
            match name.as_str() {
                "limit" if limit.is_none() => limit = Some(value),
                "sessionId" if session_id.is_none() => session_id = Some(value),
                "agentId" if agent_id.is_none() => agent_id = Some(value),
                _ => return Err(()),
            }
        }
    }
    match route {
        Route::Recent if session_id.is_some() || agent_id.is_some() => return Err(()),
        Route::SessionTimeseries
            if session_id.is_none() || agent_id.is_none() || limit.is_some() =>
        {
            return Err(());
        }
        _ => {}
    }
    Ok(RequestView {
        route,
        limit,
        session_id: session_id.unwrap_or_default(),
        agent_id: agent_id.unwrap_or_default(),
    })
}

fn decode_limit(
    raw_limit: Option<&str>,
    default_limit: usize,
    max_limit: usize,
) -> Result<usize, ()> {
    match raw_limit {
        None => Ok(default_limit),
        Some(value) => value
            .parse::<usize>()
            .ok()
            .filter(|value| *value > 0 && *value <= max_limit)
            .ok_or(()),
    }
}

fn percent_decode_query_component(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        match byte {
            b'+' => bytes.push(b' '),
            b'%' => {
                let high = hex(input.next()?)?;
                let low = hex(input.next()?)?;
                bytes.push((high << 4) | low);
            }
            byte => bytes.push(byte),
        }
    }
    String::from_utf8(bytes).ok()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

enum UsageDelivery {
    Ok(UsageResponse),
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageResponse {
    entries: Vec<UsageEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageEntry {
    session_id: String,
    agent_id: String,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost_usd: Option<f64>,
}

impl UsageDelivery {
    fn from_result(result: Result<Vec<ModelUsageEntry>, UsageReadError>) -> Self {
        match result {
            Ok(entries) => Self::Ok(UsageResponse {
                entries: entries
                    .into_iter()
                    .map(|entry| UsageEntry {
                        session_id: entry.session_id,
                        agent_id: entry.agent_id,
                        timestamp: entry.timestamp,
                        model: entry.model,
                        provider: entry.provider,
                        input_tokens: entry.input_tokens,
                        output_tokens: entry.output_tokens,
                        cache_read_tokens: entry.cache_read_tokens,
                        cache_write_tokens: entry.cache_write_tokens,
                        total_tokens: entry.total_tokens,
                        cost_usd: entry.cost_usd,
                    })
                    .collect(),
            }),
            Err(_) => Self::Unavailable,
        }
    }

    fn into_response_body(self) -> ResponseBody {
        match self {
            Self::Ok(response) => ResponseBody {
                status: 200,
                body: usage_response_json(&response),
            },
            Self::Unavailable => ResponseBody {
                status: 503,
                body: serde_json::json!({
                    "success": false,
                    "error": "OpenClaw usage history is unavailable",
                }),
            },
        }
    }
}

struct ResponseBody {
    status: u16,
    body: Value,
}

impl ResponseBody {
    fn bad_request() -> Self {
        Self::fixed(400, "OpenClaw usage history request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "OpenClaw usage history authorization is invalid")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }
}

fn response(body: ResponseBody) -> Response {
    Response::json(body.status, body.body)
}

fn timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}

fn usage_response_json(response: &UsageResponse) -> Value {
    serde_json::json!({
        "entries": response
            .entries
            .iter()
            .map(usage_entry_json)
            .collect::<Vec<_>>(),
    })
}

fn usage_entry_json(entry: &UsageEntry) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("sessionId".into(), serde_json::json!(&entry.session_id));
    object.insert("agentId".into(), serde_json::json!(&entry.agent_id));
    object.insert("timestamp".into(), serde_json::json!(&entry.timestamp));
    if let Some(model) = entry.model.as_ref() {
        object.insert("model".into(), serde_json::json!(model));
    }
    if let Some(provider) = entry.provider.as_ref() {
        object.insert("provider".into(), serde_json::json!(provider));
    }
    object.insert("inputTokens".into(), serde_json::json!(entry.input_tokens));
    object.insert(
        "outputTokens".into(),
        serde_json::json!(entry.output_tokens),
    );
    object.insert(
        "cacheReadTokens".into(),
        serde_json::json!(entry.cache_read_tokens),
    );
    object.insert(
        "cacheWriteTokens".into(),
        serde_json::json!(entry.cache_write_tokens),
    );
    object.insert("totalTokens".into(), serde_json::json!(entry.total_tokens));
    if let Some(cost_usd) = entry.cost_usd {
        object.insert("costUsd".into(), serde_json::json!(cost_usd));
    }
    Value::Object(object)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(pathname, _)| pathname)
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    #[test]
    fn decodes_only_a_valid_limit() {
        assert_eq!(decode_limit(Some("12"), 100, 1_000), Ok(12));
        assert_eq!(decode_limit(None, 100, 1_000), Ok(100));
        assert_eq!(decode_limit(Some("1001"), 100, 1_000), Err(()));
    }

    #[test]
    fn rejects_wrong_replayed_or_invalid_usage_decisions() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(
            verifier
                .verify(
                    &decision(AUTHORIZATION_CAPABILITY, "ok"),
                    1,
                    RECENT_PATH,
                    AUTHORIZATION_SCOPE,
                    AUTHORIZATION_CAPABILITY,
                    AUTHORIZATION_SUBJECT,
                )
                .is_ok()
        );
        assert!(
            verifier
                .verify(
                    &decision("other.capability", "wrong"),
                    1,
                    RECENT_PATH,
                    AUTHORIZATION_SCOPE,
                    AUTHORIZATION_CAPABILITY,
                    AUTHORIZATION_SUBJECT,
                )
                .is_err()
        );
        let replay = decision(AUTHORIZATION_CAPABILITY, "replay");
        assert!(
            verifier
                .verify(
                    &replay,
                    1,
                    RECENT_PATH,
                    AUTHORIZATION_SCOPE,
                    AUTHORIZATION_CAPABILITY,
                    AUTHORIZATION_SUBJECT,
                )
                .is_ok()
        );
        assert!(
            verifier
                .verify(
                    &replay,
                    1,
                    RECENT_PATH,
                    AUTHORIZATION_SCOPE,
                    AUTHORIZATION_CAPABILITY,
                    AUTHORIZATION_SUBJECT,
                )
                .is_err()
        );
    }

    #[test]
    fn parses_only_the_fixed_limit_query() {
        let request = request_for_test("/api/usage/recent?limit=12");
        let request = RequestView::from_request(&request);
        assert_eq!(request.route, Route::Recent);
        assert_eq!(request.limit.as_deref(), Some("12"));

        for target in [
            "/api/usage/recent?other=value",
            "/api/usage/recent?limit=1&limit=2",
            "/api/usage/recent?limit",
            "/api/usage/recent?",
            "/api/usage/recent?sessionId=session-1",
            "/api/usage/recent?sessionKey=agent:main:session-1",
            "/api/usage/session-timeseries",
            "/api/usage/session-timeseries?limit=1&sessionId=session-1&agentId=main",
            "/api/usage/session-timeseries?sessionId=session-1&agentId=main&agentId=other",
        ] {
            let request = request_for_test(target);
            assert_eq!(RequestView::from_request(&request).route, Route::Invalid);
        }
    }

    #[test]
    fn parses_session_timeseries_query() {
        let request =
            request_for_test("/api/usage/session-timeseries?sessionId=session-1&agentId=main");
        let request = RequestView::from_request(&request);
        assert_eq!(request.route, Route::SessionTimeseries);
        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.agent_id, "main");
    }

    #[test]
    fn public_projection_exposes_validated_identity_and_omits_private_transcript_data() {
        let entries = vec![ModelUsageEntry {
            session_id: "session-1".to_owned(),
            agent_id: "main".to_owned(),
            timestamp: "2026-04-03T00:00:00.000Z".to_owned(),
            model: None,
            provider: None,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: 14,
            cost_usd: None,
        }];
        let body = UsageDelivery::from_result(Ok(entries))
            .into_response_body()
            .body;
        let entry = body
            .get("entries")
            .and_then(Value::as_array)
            .unwrap()
            .first()
            .unwrap();
        assert_eq!(entry.get("sessionId"), Some(&json!("session-1")));
        assert_eq!(entry.get("agentId"), Some(&json!("main")));
        let serialized = body.to_string();
        for private_field in ["transcript", "path", "raw"] {
            assert!(!serialized.contains(private_field));
        }
    }

    #[test]
    fn unavailable_response_is_redacted() {
        let body = UsageDelivery::from_result(Err(UsageReadError::Unavailable))
            .into_response_body()
            .body;
        assert_eq!(
            body,
            json!({ "success": false, "error": "OpenClaw usage history is unavailable" })
        );
        assert!(!body.to_string().contains("private native failure"));
    }

    #[test]
    fn fixed_error_responses_do_not_echo_request_content() {
        for response in [ResponseBody::bad_request(), ResponseBody::unauthorized()] {
            let body = response.body.to_string();
            assert!(!body.contains("private"));
            assert!(!body.contains("/agents/"));
            assert!(!body.contains("transcript"));
        }
    }

    fn request_for_test(path: &str) -> Request {
        Request {
            head: RequestHead::new(
                "GET".to_owned(),
                path.to_owned(),
                Vec::new(),
                false,
                None,
                None,
            ),
            body: Vec::new(),
        }
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[37; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(capability: &str, correlation: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "usage-test",
            "endpoint": RECENT_PATH,
            "scope": AUTHORIZATION_SCOPE,
            "capability": capability,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": 60_000,
            "correlation": correlation,
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
