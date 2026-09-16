//! Native Remote Fleet custom provider.
//!
//! Custom targets use the provider's websocket endpoint for both terminal
//! relay and the typed external command boundary. Credentials are resolved only
//! while opening the connection and are never placed in a URL or event.

use std::{fmt, time::Duration};

use fleet::{
    CustomTargetConfig, FleetSecretResolution, FleetSecretResolverPort, command::CommandKind,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header},
};

use crate::fleet::terminal::{
    ProviderCommand, ProviderError, ProviderEvent, TerminalContext, TerminalProviderOpen,
};

const CUSTOM_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
const CUSTOM_TERMINAL_PROTOCOL: &str = "remote-fleet-terminal/v1";
const MAX_FRAME_BYTES: usize = 64 * 1024;
const TERMINAL_CLOSE: &str = "terminal.close";
const TERMINAL_ERROR: &str = "terminal.error";
const TERMINAL_EXIT: &str = "terminal.exit";
const TERMINAL_PING: &str = "terminal.ping";
const TERMINAL_PONG: &str = "terminal.pong";
const TERMINAL_READY: &str = "terminal.ready";
const TERMINAL_RESIZE: &str = "terminal.resize";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CustomEffect {
    Probe,
    Install,
    Start,
    Stop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CustomEffectError {
    ExternalProducerUnavailable,
    ProviderRejected,
    ProviderUnknown,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct CustomProducerRequest {
    endpoint: String,
    credential: Option<String>,
    operation: CustomEffect,
}

impl CustomProducerRequest {
    pub(crate) fn from_config(config: &CustomTargetConfig, operation: CustomEffect) -> Self {
        Self {
            endpoint: config.endpoint().to_owned(),
            credential: config.credential().map(|reference| reference.to_string()),
            operation,
        }
    }
    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }
    pub(crate) fn credential_reference(&self) -> Option<&str> {
        self.credential.as_deref()
    }
    pub(crate) const fn operation(&self) -> CustomEffect {
        self.operation
    }
}

pub(crate) trait CustomEffectProducer {
    fn execute<R: FleetSecretResolverPort>(
        &self,
        request: &CustomProducerRequest,
        resolver: &mut R,
    ) -> Result<(), CustomEffectError>
    where
        R::Secret: AsRef<str>;
}

/// Custom bootstrap/install has no producer in the source-backed system. This
/// remains an explicit external boundary; terminal is not routed through it.
#[derive(Default)]
pub(crate) struct UnavailableCustomProducer;
impl CustomEffectProducer for UnavailableCustomProducer {
    fn execute<R: FleetSecretResolverPort>(
        &self,
        _request: &CustomProducerRequest,
        _resolver: &mut R,
    ) -> Result<(), CustomEffectError>
    where
        R::Secret: AsRef<str>,
    {
        Err(CustomEffectError::ExternalProducerUnavailable)
    }
}

pub(crate) fn operation_for(kind: CommandKind) -> Option<CustomEffect> {
    match kind {
        CommandKind::ProbeNode => Some(CustomEffect::Probe),
        CommandKind::InstallAgent => Some(CustomEffect::Install),
        CommandKind::StartRuntime => Some(CustomEffect::Start),
        CommandKind::StopRuntime => Some(CustomEffect::Stop),
        CommandKind::SyncCapabilities
        | CommandKind::UpgradeAgent
        | CommandKind::MountWorkspace
        | CommandKind::ExposePort => None,
    }
}

pub(crate) fn supports_terminal_protocol(terminal: &fleet::CustomTerminalConfig) -> bool {
    terminal.transport() == fleet::CustomTerminalTransport::Websocket
        && terminal.protocol_version() == CUSTOM_TERMINAL_PROTOCOL
}

pub(crate) async fn open_terminal<R: FleetSecretResolverPort>(
    config: &CustomTargetConfig,
    resolver: &mut R,
    context: &TerminalContext,
) -> Result<TerminalProviderOpen, ProviderError>
where
    R::Secret: AsRef<str>,
{
    let rows = context.rows;
    let cols = context.cols;
    if !(1..=1000).contains(&rows) || !(1..=1000).contains(&cols) {
        return Err(ProviderError::message(
            "custom terminal dimensions are invalid",
        ));
    }
    let terminal = config
        .terminal()
        .ok_or_else(|| ProviderError::message("custom terminal configuration is missing"))?;
    if !supports_terminal_protocol(terminal) {
        return Err(ProviderError::message(
            "custom terminal protocol is unsupported",
        ));
    }
    validate_endpoint(terminal.endpoint())?;
    // `credentialRefName` names an entry in the legacy node.secretRefs map.
    // The typed target config intentionally does not carry that map, so using
    // the unrelated top-level provider credential would bind the wrong secret.
    // Refuse that configuration until the source-backed mapping is available.
    let credential_reference = terminal_credential_reference(config, terminal)?;
    let credential = match credential_reference {
        None => None,
        Some(reference) => match resolver
            .resolve(reference)
            .map_err(|_| ProviderError::message("custom terminal secret unavailable"))?
        {
            FleetSecretResolution::Resolved(value) if !value.as_ref().trim().is_empty() => {
                Some(value.as_ref().to_owned())
            }
            FleetSecretResolution::Resolved(_) => {
                return Err(ProviderError::message("custom terminal secret is empty"));
            }
            FleetSecretResolution::AccessDenied => {
                return Err(ProviderError::message(
                    "custom terminal secret access denied",
                ));
            }
            FleetSecretResolution::NotFound => {
                return Err(ProviderError::message("custom terminal secret is missing"));
            }
        },
    };
    let mut request = terminal
        .endpoint()
        .into_client_request()
        .map_err(|_| ProviderError::message("custom terminal endpoint is invalid"))?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        header::HeaderValue::from_static(CUSTOM_TERMINAL_PROTOCOL),
    );
    request.headers_mut().insert(
        "X-Remote-Fleet-Terminal-Session-Id",
        header_value(context.session.as_str())?,
    );
    request.headers_mut().insert(
        "X-Remote-Fleet-Node-Id",
        header_value(context.node.as_str())?,
    );
    request.headers_mut().insert(
        "X-Remote-Fleet-Endpoint-Id",
        header_value(context.endpoint.as_str())?,
    );
    request.headers_mut().insert(
        "X-Remote-Fleet-Terminal-Rows",
        header_value(&rows.to_string())?,
    );
    request.headers_mut().insert(
        "X-Remote-Fleet-Terminal-Cols",
        header_value(&cols.to_string())?,
    );
    if let Some(token) = credential.as_deref() {
        request.headers_mut().insert(
            header::AUTHORIZATION,
            header_value(&format!("Bearer {token}"))?,
        );
    }
    let socket = timeout(CUSTOM_OPEN_TIMEOUT, connect_async(request))
        .await
        .map_err(|_| ProviderError::message("custom terminal websocket open timed out"))?
        .map_err(|_| ProviderError::message("custom terminal websocket failed to open"))?
        .0;
    let (commands, command_rx) = mpsc::channel(32);
    let (events, events_rx) = mpsc::channel(32);
    tokio::spawn(run_socket(socket, command_rx, events));
    Ok(TerminalProviderOpen {
        commands,
        events: events_rx,
    })
}

fn terminal_credential_reference<'a>(
    _config: &'a CustomTargetConfig,
    terminal: &'a fleet::CustomTerminalConfig,
) -> Result<Option<&'a fleet::FleetSecretRef>, ProviderError> {
    if terminal.credential_ref_name().is_some() {
        return Err(ProviderError::message(
            "custom terminal credentialRefName mapping is unavailable",
        ));
    }
    Ok(None)
}

fn validate_endpoint(value: &str) -> Result<reqwest::Url, ProviderError> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| ProviderError::message("custom terminal endpoint is invalid"))?;
    if !matches!(url.scheme(), "ws" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(ProviderError::message(
            "custom terminal endpoint is invalid",
        ));
    }
    if url.scheme() == "ws"
        && !url.host_str().is_some_and(|host| {
            matches!(
                host.trim_matches(['[', ']']),
                "localhost" | "127.0.0.1" | "::1"
            )
        })
    {
        return Err(ProviderError::message(
            "custom terminal ws endpoint must be loopback",
        ));
    }
    Ok(url)
}

fn header_value(value: &str) -> Result<header::HeaderValue, ProviderError> {
    header::HeaderValue::from_str(value)
        .map_err(|_| ProviderError::message("custom terminal header is invalid"))
}

type CustomSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn run_socket(
    mut socket: CustomSocket,
    mut commands: mpsc::Receiver<ProviderCommand>,
    events: mpsc::Sender<Result<ProviderEvent, ProviderError>>,
) {
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(ProviderCommand::Input(data)) if data.len() <= MAX_FRAME_BYTES => { if socket.send(Message::Binary(data.into())).await.is_err() { break; } }
                Some(ProviderCommand::Resize { rows, cols }) => { if socket.send(TerminalControlFrame::resize(rows, cols).into_message()).await.is_err() { break; } }
                Some(ProviderCommand::Input(_)) => { let _ = events.send(Err(ProviderError::message("custom terminal input is too large"))).await; break; }
                None => { let _ = socket.send(TerminalControlFrame::close().into_message()).await; let _ = socket.close(None).await; break; }
            },
            message = socket.next() => match message {
                Some(Ok(Message::Binary(data))) if data.len() <= MAX_FRAME_BYTES => { if events.send(Ok(ProviderEvent::Output(data.to_vec()))).await.is_err() { break; } }
                Some(Ok(Message::Text(text))) => match parse_control(text.as_ref(), &mut socket, &events).await { ControlResult::Continue => {}, ControlResult::Exit => break },
                Some(Ok(Message::Ping(payload))) => { if socket.send(Message::Pong(payload)).await.is_err() { break; } }
                Some(Ok(Message::Close(frame))) => { let _ = events.send(Ok(ProviderEvent::Exit { code: frame.and_then(|f| i32::try_from(u16::from(f.code)).ok()) })).await; break; }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => { let _ = events.send(Err(ProviderError::message("custom terminal websocket failed"))).await; break; }
            }
        }
    }
}

struct TerminalControlFrame(serde_json::Value);

impl TerminalControlFrame {
    fn resize(rows: u16, cols: u16) -> Self {
        Self(serde_json::json!({"type": TERMINAL_RESIZE, "rows": rows, "cols": cols}))
    }

    fn close() -> Self {
        Self(serde_json::json!({"type": TERMINAL_CLOSE, "reason": "closed by host"}))
    }

    fn pong(nonce: Option<&str>) -> Self {
        Self(serde_json::json!({"type": TERMINAL_PONG, "nonce": nonce}))
    }

    fn into_message(self) -> Message {
        Message::Text(self.0.to_string().into())
    }
}

enum ControlResult {
    Continue,
    Exit,
}
async fn parse_control(
    text: &str,
    socket: &mut CustomSocket,
    events: &mpsc::Sender<Result<ProviderEvent, ProviderError>>,
) -> ControlResult {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        let _ = events
            .send(Err(ProviderError::message(
                "custom terminal control frame is invalid",
            )))
            .await;
        return ControlResult::Exit;
    };
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some(TERMINAL_ERROR) => {
            let _ = events
                .send(Err(ProviderError::message("custom terminal remote error")))
                .await;
            ControlResult::Exit
        }
        Some(TERMINAL_EXIT) | Some(TERMINAL_CLOSE) => {
            let code = value
                .get("exitCode")
                .and_then(serde_json::Value::as_i64)
                .and_then(|v| i32::try_from(v).ok());
            let _ = events.send(Ok(ProviderEvent::Exit { code })).await;
            ControlResult::Exit
        }
        Some(TERMINAL_PING) => {
            let nonce = value.get("nonce").and_then(serde_json::Value::as_str);
            let _ = socket
                .send(TerminalControlFrame::pong(nonce).into_message())
                .await;
            ControlResult::Continue
        }
        Some(TERMINAL_READY) | Some(TERMINAL_RESIZE) | Some(TERMINAL_PONG) => {
            ControlResult::Continue
        }
        _ => {
            let _ = events
                .send(Err(ProviderError::message(
                    "custom terminal control frame is invalid",
                )))
                .await;
            ControlResult::Exit
        }
    }
}

impl fmt::Debug for CustomProducerRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CustomProducerRequest")
            .field("endpoint", &self.endpoint)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .field("operation", &self.operation)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet::{CustomTargetConfig, FleetSecretRef};
    #[test]
    fn request_keeps_private_credential_as_reference_only() {
        let reference = FleetSecretRef::parse("remote-fleet://credentials/custom").unwrap();
        let config =
            CustomTargetConfig::try_new("wss://provider.example.test/attach", Some(reference))
                .unwrap();
        let request = CustomProducerRequest::from_config(&config, CustomEffect::Probe);
        assert_eq!(request.endpoint(), "wss://provider.example.test/attach");
        assert!(request.credential_reference().is_some());
        assert_eq!(request.operation(), CustomEffect::Probe);
        assert!(!format!("{request:?}").contains("secret-value"));
    }
}
