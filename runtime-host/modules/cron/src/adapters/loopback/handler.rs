use platform::capability::CapabilityDecisionVerifier;

use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::{sync::Mutex, time::timeout};

use platform::loopback;

use crate::api::CronHandle;

use super::wire::{
    CREATE_PATH, CronHistoryQuery, CronRequest, DELETE_PATH, DecodeError, LIST_PATH,
    SESSION_HISTORY_PATH, TOGGLE_PATH, TRIGGER_PATH, UPDATE_PATH, delete_body, history_body,
    job_body, list_body, trigger_body,
};

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024 + 64 * 1024;
// The renderer's authenticated Host API request has a 30-second public budget.
// Keep the native operation inside that budget: a 5-second transport cutoff
// incorrectly reclassified an in-flight Gateway handshake as malformed input.
pub const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
pub const AUTHORIZATION_HEADER: &str = "authorization";
pub const BEARER_PREFIX: &str = "Bearer ";

fn debug_cron_transport(stage: &'static str) {
    if std::env::var_os("MATCHACLAW_DEBUG_CRON_PROVIDER").is_some() {
        eprintln!("[DEBUG-cron-provider] host={stage}");
    }
}

pub fn loopback_body_policy(head: &loopback::RequestHead) -> Option<loopback::BodyPolicy> {
    if !is_loopback_candidate_target(&head.path) {
        return None;
    }
    if head.method == "GET" {
        Some(loopback::BodyPolicy::Empty)
    } else {
        Some(loopback::BodyPolicy::Required {
            max_bytes: MAX_REQUEST_BYTES,
        })
    }
}

pub const fn loopback_deadline() -> Duration {
    REQUEST_DEADLINE
}

pub fn loopback_timeout_response() -> loopback::Response {
    let response = Response::gateway_timeout();
    loopback::Response::json(response.status, response.body)
}

pub async fn handle_loopback(
    request: loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    cron: CronHandle,
) -> Option<loopback::Response> {
    if !is_loopback_candidate_target(request.path()) {
        return None;
    }
    if request.method() == "GET" && !request.body.is_empty() {
        return Some(into_loopback_response(Response::bad_request()));
    }
    if request.method() != "GET" && request.body.len() > MAX_REQUEST_BYTES {
        return Some(into_loopback_response(Response::bad_request()));
    }
    let (path, query) = match split_target(request.path()) {
        Ok(target) => target,
        Err(()) => {
            return Some(into_loopback_response(Response::bad_request()));
        }
    };
    let response = match timeout(
        REQUEST_DEADLINE,
        handle(
            Request {
                method: request.head.method,
                path,
                query,
                headers: request.head.headers,
                body: request.body,
            },
            verifier,
            cron,
        ),
    )
    .await
    {
        Ok(response) => response,
        Err(_) => Response::gateway_timeout(),
    };
    Some(into_loopback_response(response))
}

fn into_loopback_response(response: Response) -> loopback::Response {
    loopback::Response::json(response.status, response.body)
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    cron: CronHandle,
) -> Response {
    debug_cron_transport("request_entered");
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        debug_cron_transport("authorization_missing");
        return Response::unauthorized();
    };

    if request.method == "GET" && request.path == SESSION_HISTORY_PATH {
        let mut verifier = verifier.lock().await;
        let query = match CronHistoryQuery::decode(
            request.query.as_deref(),
            authorization,
            &mut verifier,
            now_millis(),
        ) {
            Ok(query) => query,
            Err(DecodeError::Unauthorized) => {
                debug_cron_transport("authorization_rejected");
                return Response::unauthorized();
            }
            Err(DecodeError::Invalid) => {
                debug_cron_transport("request_invalid");
                return Response::bad_request();
            }
        };
        drop(verifier);
        return handle_history(cron, query).await;
    }

    if request.method != "POST"
        || !matches!(
            request.path.as_str(),
            LIST_PATH | CREATE_PATH | UPDATE_PATH | DELETE_PATH | TOGGLE_PATH | TRIGGER_PATH
        )
        || request.query.is_some()
    {
        debug_cron_transport("route_rejected");
        return Response::not_found();
    }
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            debug_cron_transport("json_invalid");
            return Response::bad_request();
        }
    };
    let mut verifier = verifier.lock().await;
    let request = match CronRequest::decode(
        &request.path,
        value,
        authorization,
        &mut verifier,
        now_millis(),
    ) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => {
            debug_cron_transport("authorization_rejected");
            return Response::unauthorized();
        }
        Err(DecodeError::Invalid) => {
            debug_cron_transport("request_invalid");
            return Response::bad_request();
        }
    };
    drop(verifier);

    let (status, body) = match request {
        CronRequest::List => {
            debug_cron_transport("owner_request_entered");
            let outcome = cron
                .list()
                .await
                .unwrap_or(crate::model::CronListOutcome::Unavailable);
            if !matches!(outcome, crate::model::CronListOutcome::Listed(_)) {
                debug_cron_transport("owner_request_failed");
            }
            list_body(outcome)
        }
        CronRequest::Create(command) => job_body(
            cron.create(command)
                .await
                .unwrap_or(crate::model::CronJobMutationOutcome::Unavailable),
        ),
        CronRequest::Update(command) => job_body(
            cron.update(command)
                .await
                .unwrap_or(crate::model::CronJobMutationOutcome::Unavailable),
        ),
        CronRequest::Delete(command) => delete_body(
            cron.delete(command)
                .await
                .unwrap_or(crate::model::CronDeleteOutcome::Unavailable),
        ),
        CronRequest::Trigger(job_id) => trigger_body(
            cron.trigger(job_id)
                .await
                .unwrap_or(Err(crate::ports::CronRequestAdmissionClosed)),
        ),
    };
    Response { status, body }
}

fn is_loopback_candidate_target(target: &str) -> bool {
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    matches!(
        path,
        LIST_PATH
            | CREATE_PATH
            | UPDATE_PATH
            | DELETE_PATH
            | TOGGLE_PATH
            | TRIGGER_PATH
            | SESSION_HISTORY_PATH
    )
}

fn split_target(target: &str) -> Result<(String, Option<String>), ()> {
    match target.split_once('?') {
        Some((path, query)) if !path.is_empty() && !query.is_empty() => {
            Ok((path.to_owned(), Some(query.to_owned())))
        }
        Some(_) => Err(()),
        None => Ok((target.to_owned(), None)),
    }
}

async fn handle_history(cron: CronHandle, query: CronHistoryQuery) -> Response {
    let command = match query.into_command() {
        Ok(command) => command,
        Err(DecodeError::Invalid | DecodeError::Unauthorized) => return Response::bad_request(),
    };
    let outcome = cron
        .load_history(command)
        .await
        .unwrap_or(crate::model::CronHistoryOutcome::Unavailable);
    let (status, body) = history_body(outcome);
    Response { status, body }
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: Value,
}

impl Response {
    pub fn bad_request() -> Self {
        Self::fixed(400, "Cron request is invalid")
    }

    pub fn unauthorized() -> Self {
        Self::fixed(401, "Cron authorization is invalid")
    }

    pub fn not_found() -> Self {
        Self::fixed(404, "Cron route is not available")
    }

    pub fn gateway_timeout() -> Self {
        Self::fixed(504, "Cron service deadline exceeded")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
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
    fn response_reason_covers_gateway_timeout() {
        assert_eq!(Response::gateway_timeout().status, 504);
        assert_eq!(Response::gateway_timeout().body["success"], false);
    }
}
