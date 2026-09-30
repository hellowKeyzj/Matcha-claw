use super::super::{
    config_read::{
        DecodeError as ConfigReadDecodeError, Delivery as ConfigReadDelivery,
        Request as ConfigReadRequest, decode as decode_config_read,
    },
    credentials::{
        DecodeError as CredentialsDecodeError, Delivery as CredentialsDelivery,
        Request as CredentialsRequest, decode as decode_credentials,
    },
};
use super::{DecodeError, Delivery, Request, decode};
use crate::{api::ChannelHandle, domain::operations::ChannelKey};
use platform::capability::CapabilityDecisionVerifier;
use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde_json::Value;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const MAX_BODY_BYTES: usize = 320 * 1024;
const EXISTING_MAX_BODY_BYTES: usize = 64 * 1024;
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const CONFIG_READ_PATH: &str = "/api/channels/config/read";
const CREDENTIALS_VALIDATE_PATH: &str = "/api/channels/credentials/validate";

pub async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    channel_endpoint: RuntimeEndpoint,
) -> platform::loopback::Response {
    let max_body_bytes = if path == CREDENTIALS_VALIDATE_PATH {
        MAX_BODY_BYTES
    } else {
        EXISTING_MAX_BODY_BYTES
    };
    if !super::super::request_body_within_limit(headers, body, max_body_bytes) {
        return Response::fixed(400, "Channel request is invalid").into();
    }
    handle_request(
        RequestBody {
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
    request: RequestBody,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    endpoint: RuntimeEndpoint,
) -> Response {
    let trace_id = super::channel_trace_id(&request.headers);
    platform::trace::with_channel_trace(trace_id, async {
        let mut span = crate::trace::ChannelTraceSpan::begin("channel.loopback.channel_catalog");
        let response = async {
            let expected_path = match request.path.as_str() {
                "/api/channels/catalog"
                | "/api/channels/configure"
                | CONFIG_READ_PATH
                | CREDENTIALS_VALIDATE_PATH => request.path.as_str(),
                _ => return Response::not_found(),
            };
            if request.method != "POST" {
                return Response::not_found();
            }
            let Some(auth) = request
                .headers
                .iter()
                .find(|(name, _)| name == AUTHORIZATION_HEADER)
                .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
            else {
                return Response::fixed(401, "Channel authorization is invalid");
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
                    return Response::fixed(400, "Channel request is invalid");
                }
            };

            match expected_path {
                CONFIG_READ_PATH => {
                    let decoded = {
                        let mut verifier = verifier.lock().await;
                        match decode_config_read(value, auth, &mut verifier, now_millis()) {
                            Ok(request) => request,
                            Err(ConfigReadDecodeError::Unauthorized) => {
                                return Response::fixed(401, "Channel authorization is invalid");
                            }
                            Err(ConfigReadDecodeError::Invalid) => {
                                return Response::fixed(400, "Channel request is invalid");
                            }
                        }
                    };
                    let ConfigReadRequest {
                        channel: channel_id,
                        account_id,
                    } = decoded;
                    let delivery =
                        ConfigReadDelivery::Outcome(channel.config(channel_id, account_id).await);
                    Response::config_read_delivery(delivery)
                }
                CREDENTIALS_VALIDATE_PATH => {
                    let decoded = {
                        let mut verifier = verifier.lock().await;
                        match decode_credentials(value, auth, &mut verifier, now_millis()) {
                            Ok(request) => request,
                            Err(CredentialsDecodeError::Unauthorized) => {
                                return Response::fixed(401, "Channel authorization is invalid");
                            }
                            Err(CredentialsDecodeError::Invalid) => {
                                return Response::fixed(400, "Channel request is invalid");
                            }
                        }
                    };
                    let CredentialsRequest {
                        channel: channel_id,
                        config,
                    } = decoded;
                    let key = match ChannelKey::try_new(endpoint.clone(), channel_id, None) {
                        Ok(key) => key,
                        Err(_) => return Response::fixed(400, "Channel request is invalid"),
                    };
                    let delivery = match channel.validate_credentials(key, config).await {
                        Ok(outcome) => CredentialsDelivery::Outcome(outcome),
                        Err(_) => CredentialsDelivery::Unavailable,
                    };
                    Response::credentials_delivery(delivery)
                }
                "/api/channels/catalog" | "/api/channels/configure" => {
                    let mut verifier = verifier.lock().await;
                    let decoded = match decode(value, auth, &mut verifier, now_millis()) {
                        Ok(request) => request,
                        Err(DecodeError::Unauthorized) => {
                            return Response::fixed(401, "Channel authorization is invalid");
                        }
                        Err(DecodeError::Invalid) => {
                            return Response::fixed(400, "Channel request is invalid");
                        }
                    };
                    drop(verifier);
                    let delivery = match (expected_path, decoded) {
                        ("/api/channels/catalog", Request::Catalog) => {
                            Delivery::Catalog(channel.catalog().await)
                        }
                        (
                            "/api/channels/configure",
                            Request::ConfigureForm {
                                channel: channel_id,
                            },
                        ) => Delivery::ConfigureForm(channel.configure_form(channel_id).await),
                        (
                            "/api/channels/configure",
                            Request::ConfigureApply {
                                channel: channel_id,
                                account_id,
                                agent_id,
                                values,
                            },
                        ) => {
                            let key = match ChannelKey::try_new(
                                endpoint.clone(),
                                channel_id,
                                Some(account_id),
                            ) {
                                Ok(key) => key,
                                Err(_) => {
                                    return Response::fixed(400, "Channel request is invalid");
                                }
                            };
                            match channel.configure(key, agent_id, values).await {
                                Ok(crate::api::ConfigureDelivery::Outcome(outcome)) => {
                                    Delivery::Configure(outcome)
                                }
                                Ok(crate::api::ConfigureDelivery::Accepted(receipt)) => {
                                    return Response {
                                        status: 202,
                                        body: serde_json::json!(receipt),
                                    };
                                }
                                Err(_) => Delivery::Unavailable,
                            }
                        }
                        _ => return Response::fixed(400, "Channel request is invalid"),
                    };
                    Response::delivery(delivery)
                }
                _ => Response::not_found(),
            }
        }
        .await;
        span.finish(match response.status {
            202 => "accepted",
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

struct RequestBody {
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
    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({"success": false, "error": error}),
        }
    }
    fn not_found() -> Self {
        Self::fixed(404, "Channel route is not available")
    }
    fn delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
    fn config_read_delivery(delivery: ConfigReadDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
    fn credentials_delivery(delivery: CredentialsDelivery) -> Self {
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
