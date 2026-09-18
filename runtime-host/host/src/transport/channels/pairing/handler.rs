use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::channel::{ChannelHandle, ChannelKey};
use crate::transport::common::authorization::CapabilityDecisionVerifier;

use super::{ChannelPairingDelivery, DecodeError, decode_approval, decode_list};

const MAX_BODY_BYTES: usize = 256;
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    channel_endpoint: RuntimeEndpoint,
) -> crate::transport::localhost::Response {
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
        channel_endpoint,
    )
    .await
    .into()
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    endpoint: RuntimeEndpoint,
) -> Response {
    let trace_id = super::super::catalog::channel_trace_id(&request.headers);
    openclaw::operations::channel_config::with_channel_trace(trace_id, async {
        let mut span =
            crate::channel::trace::ChannelTraceSpan::begin("host.transport.channel_pairing");
        let response = async {
            if request.method != "POST" || request.path != "/api/channels/pairing" {
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
                    openclaw::operations::channel_config::channel_trace(
                        "host.transport.json_decode",
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
            if value.get("action").and_then(Value::as_str) == Some("approve") {
                match decode_approval(value, authorization, &mut verifier, now_millis()) {
                    Ok(command) => {
                        drop(verifier);
                        let key =
                            match ChannelKey::try_new(endpoint, command.channel, command.account) {
                                Ok(key) => key,
                                Err(_) => return Response::bad_request(),
                            };
                        match channel.approve_pairing(key, command.code).await {
                            Ok(outcome) => Response::approval(outcome),
                            Err(_) => Response::unavailable(),
                        }
                    }
                    Err(DecodeError::Unauthorized) => Response::unauthorized(),
                    Err(DecodeError::Invalid) => Response::bad_request(),
                }
            } else {
                match decode_list(value, authorization, &mut verifier, now_millis()) {
                    Ok((channel_id, account)) => {
                        drop(verifier);
                        Response::from_delivery(ChannelPairingDelivery::from_outcome(
                            channel.pairing(channel_id, account).await,
                        ))
                    }
                    Err(DecodeError::Unauthorized) => Response::unauthorized(),
                    Err(DecodeError::Invalid) => Response::bad_request(),
                }
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

impl From<Response> for crate::transport::localhost::Response {
    fn from(response: Response) -> Self {
        Self::json(response.status, response.body)
    }
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Channel pairing request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Channel pairing authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Channel pairing route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(ChannelPairingDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: ChannelPairingDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn approval(outcome: crate::channel::status::ChannelPairingApprovalOutcome) -> Self {
        Self {
            status: 200,
            body: serde_json::to_value(outcome)
                .expect("Channel pairing approval public response is serializable"),
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
