use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{api::ChannelHandle, domain::operations::ChannelKey};
use platform::capability::CapabilityDecisionVerifier;

use super::{ChannelControlDelivery, DecodeError, decode};

pub const MAX_BODY_BYTES: usize = 20 * 1024;
const DELETE_CONFIG_PATH: &str = "/api/channels/delete-config";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    channel_endpoint: RuntimeEndpoint,
) -> platform::loopback::Response {
    if !super::super::required_request_body_within_limit(headers, body, MAX_BODY_BYTES) {
        return Response::bad_request().into();
    }
    let cancellation = tokio_util::sync::CancellationToken::new();
    if path == "/api/channels/login" {
        let (status, body) = super::super::login::handler::handle_login(
            method,
            path,
            headers,
            body,
            verifier,
            channel,
            channel_endpoint,
            cancellation,
        )
        .await;
        return Response { status, body }.into();
    }
    handle_request(
        Request {
            method: method.to_owned(),
            path: path.to_owned(),
            headers: headers.to_vec(),
            body: body.to_vec(),
        },
        verifier,
        channel,
        channel_endpoint,
        cancellation,
    )
    .await
    .into()
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    endpoint: RuntimeEndpoint,
    _cancellation: tokio_util::sync::CancellationToken,
) -> Response {
    let trace_id = super::super::catalog::channel_trace_id(&request.headers);
    platform::trace::with_channel_trace(trace_id, async {
        let mut span = crate::trace::ChannelTraceSpan::begin("channel.loopback.channel_control");
        let response = async {
            if request.path == DELETE_CONFIG_PATH {
                return handle_delete_config(request, verifier, channel, endpoint).await;
            }
            if request.method != "POST" || request.path != "/api/channels/control" {
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
            let value = match serde_json::from_slice::<Value>(&request.body) {
                Ok(value) => value,
                Err(error) => {
                    platform::trace::channel_trace(
                        "channel.loopback.json_decode",
                        match error.classify() {
                            serde_json::error::Category::Io => "outcome=io",
                            serde_json::error::Category::Syntax => "outcome=syntax",
                            serde_json::error::Category::Data => "outcome=data",
                            serde_json::error::Category::Eof => "outcome=eof",
                        },
                    );
                    return Response::bad_request();
                }
            };
            let mut verifier = verifier.lock().await;
            let command = match decode(value, authorization, &mut verifier, now_millis()) {
                Ok(command) => command,
                Err(DecodeError::Unauthorized) => return Response::unauthorized(),
                Err(DecodeError::Invalid) => return Response::bad_request(),
            };
            drop(verifier);
            let key = match ChannelKey::try_new(endpoint, command.channel, Some(command.account)) {
                Ok(key) => key,
                Err(_) => return Response::bad_request(),
            };
            match channel.control(key, command.action).await {
                Ok(outcome) => {
                    Response::from_delivery(ChannelControlDelivery::Outcome(outcome.into()))
                }
                Err(_) => Response::unavailable(),
            }
        }
        .await;
        span.finish(match response.status {
            200 => "delivered",
            400 => "invalid",
            401 => "unauthorized",
            404 => "not_found",
            _ => "unavailable",
        });
        response
    })
    .await
}

async fn handle_delete_config(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    endpoint: RuntimeEndpoint,
) -> Response {
    if request.method != "POST" {
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
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(error) => {
            platform::trace::channel_trace(
                "channel.loopback.json_decode",
                match error.classify() {
                    serde_json::error::Category::Io => "outcome=io",
                    serde_json::error::Category::Syntax => "outcome=syntax",
                    serde_json::error::Category::Data => "outcome=data",
                    serde_json::error::Category::Eof => "outcome=eof",
                },
            );
            return Response::bad_request();
        }
    };
    let mut verifier = verifier.lock().await;
    let command =
        match super::super::delete::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(command) => command,
            Err(super::super::delete::DecodeError::Unauthorized) => {
                return Response::unauthorized();
            }
            Err(super::super::delete::DecodeError::Invalid) => {
                return Response::bad_request();
            }
        };
    drop(verifier);
    let key = match ChannelKey::try_new(endpoint, command.channel, command.account_id) {
        Ok(key) => key,
        Err(_) => return Response::bad_request(),
    };
    let delivery = match channel.delete_config(key).await {
        Ok(outcome) => super::super::delete::Delivery::Outcome(outcome),
        Err(_) => super::super::delete::Delivery::Unavailable,
    };
    Response {
        status: delivery.status_code(),
        body: delivery.body(),
    }
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    body: Value,
}

impl From<Response> for platform::loopback::Response {
    fn from(response: Response) -> Self {
        Self::json(response.status, response.body)
    }
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Channel control request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Channel control authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Channel control route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(ChannelControlDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: ChannelControlDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
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
