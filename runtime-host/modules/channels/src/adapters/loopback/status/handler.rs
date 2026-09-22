use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::api::ChannelHandle;
use platform::capability::CapabilityDecisionVerifier;

use super::{ChannelStatusDelivery, ChannelStatusRequest, DecodeError, decode};

const MAX_BODY_BYTES: usize = 256;
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    _channel_endpoint: RuntimeEndpoint,
) -> platform::loopback::Response {
    if !super::super::request_body_within_limit(headers, body, MAX_BODY_BYTES) {
        return Response::bad_request().into();
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
    )
    .await
    .into()
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
) -> Response {
    let trace_id = super::super::catalog::channel_trace_id(&request.headers);
    platform::trace::with_channel_trace(trace_id, async {
        let mut span =
            crate::application::trace::ChannelTraceSpan::begin("channel.loopback.channel_status");
        let response = async {
            if request.method != "POST" || request.path != "/api/channels/status" {
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
            let request = {
                let mut verifier = verifier.lock().await;
                match decode(value, authorization, &mut verifier, now_millis()) {
                    Ok(request) => request,
                    Err(DecodeError::Unauthorized) => return Response::unauthorized(),
                    Err(DecodeError::Invalid) => return Response::bad_request(),
                }
            };
            match request {
                ChannelStatusRequest::Accounts => match channel.status().await {
                    Ok(outcome) => {
                        Response::from_delivery(ChannelStatusDelivery::Accounts(outcome))
                    }
                    Err(_) => Response::unavailable(),
                },
                ChannelStatusRequest::Snapshot => match channel.snapshot().await {
                    Ok(outcome) => {
                        Response::from_delivery(ChannelStatusDelivery::Snapshot(outcome))
                    }
                    Err(_) => Response::unavailable(),
                },
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
        Self::fixed(400, "Channel status request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Channel status authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Channel status route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(ChannelStatusDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: ChannelStatusDelivery) -> Self {
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
