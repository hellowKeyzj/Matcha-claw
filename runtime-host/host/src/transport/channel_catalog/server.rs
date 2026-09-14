use super::{DecodeError, Delivery, Request, decode};
use crate::{
    channel::{ChannelHandle, ChannelKey},
    transport::{
        authorization::CapabilityDecisionVerifier,
        channel_config_read::{
            DecodeError as ConfigReadDecodeError, Delivery as ConfigReadDelivery,
            Request as ConfigReadRequest, decode as decode_config_read,
        },
        channel_credentials::{
            DecodeError as CredentialsDecodeError, Delivery as CredentialsDelivery,
            Request as CredentialsRequest, decode as decode_credentials,
        },
    },
};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde_json::Value;
use std::{
    io,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::timeout,
};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_BODY_BYTES: usize = 320 * 1024;
const EXISTING_MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_READ_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const CONFIG_READ_PATH: &str = "/api/channels/config/read";
const CREDENTIALS_VALIDATE_PATH: &str = "/api/channels/credentials/validate";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    endpoint: RuntimeEndpoint,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        channel: ChannelHandle,
        endpoint: RuntimeEndpoint,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            channel,
            endpoint,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let channel = self.channel.clone();
            let endpoint = self.endpoint.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, channel, endpoint).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    endpoint: RuntimeEndpoint,
) -> io::Result<()> {
    let request = match timeout(REQUEST_READ_DEADLINE, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => return Err(error),
        Err(_) => Err(Response::fixed(400, "Channel request deadline exceeded")),
    };
    let response = match request {
        Ok(request) => handle(request, verifier, channel, endpoint).await,
        Err(response) => response,
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: RequestBody,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    endpoint: RuntimeEndpoint,
) -> Response {
    let trace_id = crate::transport::channel_catalog::channel_trace_id(&request.headers);
    openclaw::operations::channel_config::with_channel_trace(trace_id, async {
        let mut span =
            crate::channel::trace::ChannelTraceSpan::begin("host.transport.channel_catalog");
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
                    openclaw::operations::channel_config::channel_trace(
                        "host.transport.json_decode",
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
                                Ok(outcome) => Delivery::Configure(outcome),
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

async fn read_request(stream: &mut TcpStream) -> io::Result<Result<RequestBody, Response>> {
    let mut span =
        crate::channel::trace::ChannelTraceSpan::begin("host.transport.channel_catalog.http_read");
    let result: io::Result<Result<RequestBody, Response>> = async {
        let mut bytes = Vec::with_capacity(1024);
        let mut buffer = [0_u8; 8192];
        let header_end = loop {
            let read = stream.read(&mut buffer).await?;
            if read == 0 {
                return Ok(Err(Response::fixed(400, "Channel request is invalid")));
            }
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                let end = end + 4;
                if end > MAX_HEADER_BYTES {
                    return Ok(Err(Response::fixed(400, "Channel request is invalid")));
                }
                break end;
            }
            if bytes.len() > MAX_HEADER_BYTES {
                return Ok(Err(Response::fixed(400, "Channel request is invalid")));
            }
        };
        let header = match std::str::from_utf8(&bytes[..header_end]) {
            Ok(v) => v.to_owned(),
            Err(_) => return Ok(Err(Response::fixed(400, "Channel request is invalid"))),
        };
        let mut lines = header.split("\r\n");
        let Some(start) = lines.next() else {
            return Ok(Err(Response::fixed(400, "Channel request is invalid")));
        };
        let mut start = start.split_whitespace();
        let (Some(method), Some(path), Some(version), None) =
            (start.next(), start.next(), start.next(), start.next())
        else {
            return Ok(Err(Response::fixed(400, "Channel request is invalid")));
        };
        if version != "HTTP/1.1" {
            return Ok(Err(Response::fixed(400, "Channel request is invalid")));
        }
        let mut headers = Vec::new();
        for line in lines {
            if line.is_empty() {
                continue;
            }
            let Some((name, value)) = line.split_once(':') else {
                return Ok(Err(Response::fixed(400, "Channel request is invalid")));
            };
            let name = name.trim().to_ascii_lowercase();
            if name.is_empty()
                || headers.len() >= MAX_HEADERS
                || headers.iter().any(|(n, _)| n == &name)
            {
                return Ok(Err(Response::fixed(400, "Channel request is invalid")));
            }
            headers.push((name, value.trim().to_owned()));
        }
        let Some(length) = headers
            .iter()
            .find(|(n, _)| n == "content-length")
            .and_then(|(_, v)| v.parse::<usize>().ok())
        else {
            return Ok(Err(Response::fixed(400, "Channel request is invalid")));
        };
        let max_body_bytes = if path == CREDENTIALS_VALIDATE_PATH {
            MAX_BODY_BYTES
        } else {
            EXISTING_MAX_BODY_BYTES
        };
        if length > max_body_bytes {
            return Ok(Err(Response::fixed(400, "Channel request is invalid")));
        }
        while bytes.len() < header_end + length {
            let read = stream.read(&mut buffer).await?;
            if read == 0 || bytes.len() + read > header_end + length {
                return Ok(Err(Response::fixed(400, "Channel request is invalid")));
            }
            bytes.extend_from_slice(&buffer[..read]);
        }
        if bytes.len() != header_end + length {
            return Ok(Err(Response::fixed(400, "Channel request is invalid")));
        }
        Ok(Ok(RequestBody {
            method: method.to_owned(),
            path: path.to_owned(),
            headers,
            body: bytes[header_end..].to_vec(),
        }))
    }
    .await;
    span.finish(match &result {
        Ok(Ok(_)) => "decoded",
        Ok(Err(_)) => "invalid",
        Err(error) => {
            openclaw::operations::channel_config::channel_trace(
                "host.transport.http_read_error",
                &format!("kind={:?}", error.kind()),
            );
            "io"
        }
    });
    result
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).expect("channel response serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    stream.write_all(format!("HTTP/1.1 {response_status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len(), response_status = response.status).as_bytes()).await?;
    stream.write_all(&body).await
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
