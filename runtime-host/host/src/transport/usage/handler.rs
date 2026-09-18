use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    facade::UsageHandle,
    transport::{common::authorization::CapabilityDecisionVerifier, localhost},
};

use super::{
    AUTHORIZATION_ENDPOINT, DecodeError, SESSION_TIMESERIES_ENDPOINT, UsageDelivery, decode_limit,
};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    usage: UsageHandle,
) -> localhost::Response {
    handle_request(
        Request::from_parts(method, path, headers.to_vec()),
        verifier,
        usage,
    )
    .await
    .into()
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    usage: UsageHandle,
) -> Response {
    if request.route == Route::Invalid {
        return Response::bad_request();
    }
    if request.method != "GET" || !matches!(request.route, Route::Recent | Route::SessionTimeseries)
    {
        return Response::not_found();
    }
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::unauthorized();
    };
    let mut verifier = verifier.lock().await;
    let limit = match decode_limit(
        authorization,
        request.limit.as_deref(),
        &mut verifier,
        now_millis(),
    ) {
        Ok(limit) => limit,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    let result = match request.route {
        Route::Recent => usage.recent(limit).await,
        Route::SessionTimeseries => {
            usage
                .session_timeseries(&request.agent_id, &request.session_id)
                .await
        }
        Route::Unknown => return Response::not_found(),
        Route::Invalid => return Response::bad_request(),
    };
    Response::from_delivery(UsageDelivery::from_facade(result))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Route {
    Recent,
    SessionTimeseries,
    Unknown,
    Invalid,
}

struct Request {
    method: String,
    route: Route,
    limit: Option<String>,
    session_id: String,
    agent_id: String,
    headers: Vec<(String, String)>,
}

impl Request {
    fn from_parts(method: &str, path: &str, headers: Vec<(String, String)>) -> Self {
        let (pathname, query) = match path.split_once('?') {
            Some((pathname, query)) => (pathname, Some(query)),
            None => (path, None),
        };
        match parse_query(pathname, query) {
            Ok(query) => Self {
                method: method.to_owned(),
                route: query.route,
                limit: query.limit,
                session_id: query.session_id,
                agent_id: query.agent_id,
                headers,
            },
            Err(()) => Self {
                method: method.to_owned(),
                route: Route::Invalid,
                limit: Some(String::new()),
                session_id: String::new(),
                agent_id: String::new(),
                headers,
            },
        }
    }
}

#[derive(Debug)]
struct Response {
    status: u16,
    body: Value,
}

impl From<Response> for localhost::Response {
    fn from(response: Response) -> Self {
        Self::json(response.status, response.body)
    }
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "OpenClaw usage history request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "OpenClaw usage history authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "OpenClaw usage history route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: UsageDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
}

struct Query {
    route: Route,
    limit: Option<String>,
    session_id: String,
    agent_id: String,
}

fn parse_query(pathname: &str, query: Option<&str>) -> Result<Query, ()> {
    let route = match pathname {
        AUTHORIZATION_ENDPOINT => Route::Recent,
        SESSION_TIMESERIES_ENDPOINT => Route::SessionTimeseries,
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
    Ok(Query {
        route,
        limit,
        session_id: session_id.unwrap_or_default(),
        agent_id: agent_id.unwrap_or_default(),
    })
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
    use super::*;

    #[test]
    fn parses_only_the_fixed_limit_query() {
        let request = Request::from_parts(
            "GET",
            "/api/usage/recent?limit=12",
            vec![
                ("host".into(), "127.0.0.1".into()),
                ("authorization".into(), "Bearer signed".into()),
            ],
        );
        assert_eq!(request.route, Route::Recent);
        assert_eq!(request.limit.as_deref(), Some("12"));
        assert_eq!(request.headers.len(), 2);

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
            let request = Request::from_parts("GET", target, Vec::new());
            assert_eq!(request.route, Route::Invalid);
        }
    }

    #[test]
    fn parses_session_timeseries_query() {
        let request = Request::from_parts(
            "GET",
            "/api/usage/session-timeseries?sessionId=session-1&agentId=main",
            vec![("authorization".into(), "Bearer signed".into())],
        );
        assert_eq!(request.route, Route::SessionTimeseries);
        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.agent_id, "main");
    }

    #[test]
    fn fixed_error_responses_do_not_echo_request_content() {
        for response in [
            Response::bad_request(),
            Response::unauthorized(),
            Response::not_found(),
        ] {
            let body = response.body.to_string();
            assert!(!body.contains("private"));
            assert!(!body.contains("/agents/"));
            assert!(!body.contains("transcript"));
        }
    }
}
