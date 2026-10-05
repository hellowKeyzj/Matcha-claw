use std::{fmt, sync::Arc, time::Duration};

use platform::parent_callback::{ParentCallbackFuture, ParentShellOpenPath};
use reqwest::{Client, Response, Url};
use serde::Serialize;
use serde_json::{Value, json};

const TRANSPORT_VERSION: u8 = 1;
const SHELL_ACTION_TIMEOUT: Duration = Duration::from_secs(15);
const NOTIFICATION_TIMEOUT: Duration = Duration::from_secs(3);
const DISPATCH_TOKEN_HEADER: &str = "x-runtime-host-dispatch-token";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentCallbackEndpoint {
    ShellActions,
    GatewayEvents,
}

impl ParentCallbackEndpoint {
    pub const fn path(self) -> &'static str {
        match self {
            Self::ShellActions => "/internal/runtime-host/shell-actions",
            Self::GatewayEvents => "/internal/runtime-host/gateway-events",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentShellAction {
    ShellOpenPath,
    GatewayRestart,
    HostDiagnosticsSnapshot,
    ProviderOauthStart,
    ProviderOauthCancel,
    ProviderOauthSubmit,
}

impl ParentShellAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ShellOpenPath => "shell_open_path",
            Self::GatewayRestart => "gateway_restart",
            Self::HostDiagnosticsSnapshot => "host_diagnostics_snapshot",
            Self::ProviderOauthStart => "provider_oauth_start",
            Self::ProviderOauthCancel => "provider_oauth_cancel",
            Self::ProviderOauthSubmit => "provider_oauth_submit",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentGatewayEventName {
    GatewayLifecycle,
    GatewayNotification,
    TaskSnapshot,
    GatewayChannelStatus,
    GatewayError,
    TeamEvent,
}

impl ParentGatewayEventName {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GatewayLifecycle => "gateway:lifecycle",
            Self::GatewayNotification => "gateway:notification",
            Self::TaskSnapshot => "task:snapshot",
            Self::GatewayChannelStatus => "gateway:channel-status",
            Self::GatewayError => "gateway:error",
            Self::TeamEvent => "team:event",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentCallbackNameKind {
    ShellAction,
    GatewayEvent,
}

impl ParentCallbackNameKind {
    const fn description(self) -> &'static str {
        match self {
            Self::ShellAction => "shell action",
            Self::GatewayEvent => "gateway event",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParentCallbackNameError {
    pub kind: ParentCallbackNameKind,
    pub name: String,
}

impl fmt::Display for ParentCallbackNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "unsupported parent {}: {}",
            self.kind.description(),
            self.name
        )
    }
}

impl std::error::Error for ParentCallbackNameError {}

impl TryFrom<&str> for ParentShellAction {
    type Error = ParentCallbackNameError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        let action = match value {
            "shell_open_path" => Self::ShellOpenPath,
            "gateway_restart" => Self::GatewayRestart,
            "host_diagnostics_snapshot" => Self::HostDiagnosticsSnapshot,
            "provider_oauth_start" => Self::ProviderOauthStart,
            "provider_oauth_cancel" => Self::ProviderOauthCancel,
            "provider_oauth_submit" => Self::ProviderOauthSubmit,
            _ => {
                return Err(ParentCallbackNameError {
                    kind: ParentCallbackNameKind::ShellAction,
                    name: value.to_owned(),
                });
            }
        };
        Ok(action)
    }
}

impl TryFrom<&str> for ParentGatewayEventName {
    type Error = ParentCallbackNameError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        let event_name = match value {
            "gateway:lifecycle" => Self::GatewayLifecycle,
            "gateway:notification" => Self::GatewayNotification,
            "task:snapshot" => Self::TaskSnapshot,
            "gateway:channel-status" => Self::GatewayChannelStatus,
            "gateway:error" => Self::GatewayError,
            "team:event" => Self::TeamEvent,
            _ => {
                return Err(ParentCallbackNameError {
                    kind: ParentCallbackNameKind::GatewayEvent,
                    name: value.to_owned(),
                });
            }
        };
        Ok(event_name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentCallbackConfigError {
    EmptyBaseUrl,
    InvalidBaseUrl,
    UnsupportedScheme,
    MissingHost,
    EmptyDispatchToken,
}

impl fmt::Display for ParentCallbackConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::EmptyBaseUrl => "parent callback base URL must not be empty",
            Self::InvalidBaseUrl => "parent callback base URL is invalid",
            Self::UnsupportedScheme => "parent callback base URL must use HTTP or HTTPS",
            Self::MissingHost => "parent callback base URL must include a host",
            Self::EmptyDispatchToken => "parent callback dispatch token must not be empty",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ParentCallbackConfigError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentCallbackResponseError {
    InvalidJson,
    BodyNotObject,
    VersionMissingOrInvalid,
    VersionMismatch,
    StatusMissingOrInvalid,
    SuccessMissingOrInvalid,
    FailureErrorMissingOrInvalid,
    FailureCodeMissingOrInvalid,
    FailureMessageMissingOrInvalid,
}

impl fmt::Display for ParentCallbackResponseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidJson => "parent callback response must be valid JSON",
            Self::BodyNotObject => "parent callback response must be an object",
            Self::VersionMissingOrInvalid => "parent callback response version must be an integer",
            Self::VersionMismatch => "parent callback response version does not match the protocol",
            Self::StatusMissingOrInvalid => "parent callback response status must be an integer",
            Self::SuccessMissingOrInvalid => "parent callback response success must be a boolean",
            Self::FailureErrorMissingOrInvalid => "parent callback failure error must be an object",
            Self::FailureCodeMissingOrInvalid => {
                "parent callback failure error code must be a string"
            }
            Self::FailureMessageMissingOrInvalid => {
                "parent callback failure error message must be a string"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ParentCallbackResponseError {}

#[derive(Debug)]
pub enum ParentCallbackError {
    PayloadSerialization {
        endpoint: ParentCallbackEndpoint,
    },
    RequestTimeout {
        endpoint: ParentCallbackEndpoint,
    },
    RequestFailed {
        endpoint: ParentCallbackEndpoint,
    },
    ResponseBodyRead {
        endpoint: ParentCallbackEndpoint,
    },
    InvalidResponse {
        endpoint: ParentCallbackEndpoint,
        reason: ParentCallbackResponseError,
    },
    SessionUpdateUnavailable {
        availability: ParentSessionUpdateAvailability,
    },
    GatewayNotificationUnsupported,
}

impl fmt::Display for ParentCallbackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadSerialization { endpoint } => {
                write!(
                    formatter,
                    "failed to encode {} parent callback",
                    endpoint.path()
                )
            }
            Self::RequestTimeout { endpoint } => {
                write!(formatter, "{} parent callback timed out", endpoint.path())
            }
            Self::RequestFailed { endpoint } => {
                write!(
                    formatter,
                    "{} parent callback request failed",
                    endpoint.path()
                )
            }
            Self::ResponseBodyRead { endpoint } => {
                write!(
                    formatter,
                    "failed to read {} parent callback response",
                    endpoint.path()
                )
            }
            Self::InvalidResponse { endpoint, reason } => {
                write!(
                    formatter,
                    "invalid {} parent callback response: {reason}",
                    endpoint.path()
                )
            }
            Self::SessionUpdateUnavailable { availability } => {
                write!(
                    formatter,
                    "parent session:update callback is {availability}"
                )
            }
            Self::GatewayNotificationUnsupported => {
                formatter.write_str("parent gateway:notification callback is unsupported")
            }
        }
    }
}

impl std::error::Error for ParentCallbackError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidResponse { reason, .. } => Some(reason),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParentCallbackErrorPayload {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParentShellActionResponse {
    Success {
        status: u16,
        data: Option<Value>,
    },
    Failure {
        status: u16,
        error: ParentCallbackErrorPayload,
    },
}

impl ParentShellActionResponse {
    pub fn into_application_data(self) -> (u16, Value) {
        match self {
            Self::Success { status, data } => (status, data.unwrap_or(Value::Null)),
            Self::Failure { status, error } => (
                status,
                json!({
                    "success": false,
                    "error": error.message,
                }),
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParentCallbackDeliveryReceipt {
    endpoint: ParentCallbackEndpoint,
}

impl ParentCallbackDeliveryReceipt {
    pub const fn endpoint(self) -> ParentCallbackEndpoint {
        self.endpoint
    }
}

/// Rich `session:update` requires a complete Renderer snapshot producer.
///
/// The current native projections do not provide one, so this boundary exposes
/// the non-deliverable states instead of accepting an opaque partial payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentSessionUpdateAvailability {
    Unavailable,
    Incomplete,
}

impl fmt::Display for ParentSessionUpdateAvailability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "unavailable",
            Self::Incomplete => "incomplete",
        })
    }
}

pub type ParentCallbackClient = ParentCallbackHandle;

#[derive(Clone)]
pub struct ParentCallbackHandle {
    http_client: Client,
    parent_api_base_url: Arc<Url>,
    dispatch_token: Arc<str>,
    shell_action_timeout: Duration,
    notification_timeout: Duration,
}

impl ParentCallbackHandle {
    pub fn new(
        parent_api_base_url: impl AsRef<str>,
        dispatch_token: impl AsRef<str>,
    ) -> Result<Self, ParentCallbackConfigError> {
        let parent_api_base_url = parent_api_base_url.as_ref().trim();
        if parent_api_base_url.is_empty() {
            return Err(ParentCallbackConfigError::EmptyBaseUrl);
        }
        let parent_api_base_url = Url::parse(parent_api_base_url)
            .map_err(|_| ParentCallbackConfigError::InvalidBaseUrl)?;
        if !matches!(parent_api_base_url.scheme(), "http" | "https") {
            return Err(ParentCallbackConfigError::UnsupportedScheme);
        }
        if parent_api_base_url.host_str().is_none() {
            return Err(ParentCallbackConfigError::MissingHost);
        }

        let dispatch_token = dispatch_token.as_ref();
        if dispatch_token.trim().is_empty() {
            return Err(ParentCallbackConfigError::EmptyDispatchToken);
        }

        let http_client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("parent callback HTTP client must build");
        Ok(Self::with_timeouts(
            parent_api_base_url,
            dispatch_token.to_owned(),
            http_client,
            SHELL_ACTION_TIMEOUT,
            NOTIFICATION_TIMEOUT,
        ))
    }

    fn with_timeouts(
        parent_api_base_url: Url,
        dispatch_token: String,
        http_client: Client,
        shell_action_timeout: Duration,
        notification_timeout: Duration,
    ) -> Self {
        Self {
            http_client,
            parent_api_base_url: Arc::new(parent_api_base_url),
            dispatch_token: Arc::from(dispatch_token),
            shell_action_timeout,
            notification_timeout,
        }
    }
}

impl ParentShellOpenPath for ParentCallbackHandle {
    fn open_path<'a>(&'a self, path: std::path::PathBuf) -> ParentCallbackFuture<'a, bool> {
        Box::pin(async move {
            let Some(path) = path.to_str().map(str::to_owned) else {
                return false;
            };
            matches!(
                self.request_parent_shell_action(
                    ParentShellAction::ShellOpenPath,
                    Some(json!({ "path": path })),
                )
                .await,
                Ok(ParentShellActionResponse::Success { status, .. }) if (200..300).contains(&status)
            )
        })
    }
}

impl ParentCallbackHandle {
    #[cfg(test)]
    pub(crate) fn for_tests(
        parent_api_base_url: impl AsRef<str>,
        dispatch_token: impl AsRef<str>,
    ) -> Self {
        ParentCallbackClient::new(parent_api_base_url, dispatch_token)
            .expect("test parent callback must be valid")
    }

    pub async fn request_parent_shell_action(
        &self,
        action: ParentShellAction,
        payload: Option<Value>,
    ) -> Result<ParentShellActionResponse, ParentCallbackError> {
        let endpoint = ParentCallbackEndpoint::ShellActions;
        let request = ShellActionRequest {
            version: TRANSPORT_VERSION,
            action: action.as_str(),
            payload,
        };
        let body = encode_request(endpoint, &request)?;
        let response = self
            .send_json(endpoint, body, self.shell_action_timeout)
            .await?;
        let body = response.bytes().await.map_err(|error| {
            if error.is_timeout() {
                ParentCallbackError::RequestTimeout { endpoint }
            } else {
                ParentCallbackError::ResponseBodyRead { endpoint }
            }
        })?;
        parse_parent_shell_action_response(&body)
            .map_err(|reason| ParentCallbackError::InvalidResponse { endpoint, reason })
    }

    pub async fn emit_parent_gateway_event(
        &self,
        event_name: ParentGatewayEventName,
        payload: Value,
    ) -> Result<ParentCallbackDeliveryReceipt, ParentCallbackError> {
        if event_name == ParentGatewayEventName::GatewayNotification {
            return Err(ParentCallbackError::GatewayNotificationUnsupported);
        }
        let endpoint = ParentCallbackEndpoint::GatewayEvents;
        let request = EventNotificationRequest {
            version: TRANSPORT_VERSION,
            event_name: event_name.as_str(),
            payload,
        };
        let body = encode_request(endpoint, &request)?;
        self.send_json(endpoint, body, self.notification_timeout)
            .await?;
        Ok(ParentCallbackDeliveryReceipt { endpoint })
    }

    pub async fn emit_parent_session_update(
        &self,
        availability: ParentSessionUpdateAvailability,
    ) -> Result<ParentCallbackDeliveryReceipt, ParentCallbackError> {
        Err(ParentCallbackError::SessionUpdateUnavailable { availability })
    }

    fn endpoint_url(&self, endpoint: ParentCallbackEndpoint) -> Url {
        self.parent_api_base_url
            .join(endpoint.path())
            .expect("parent callback endpoint paths must be valid URLs")
    }

    async fn send_json(
        &self,
        endpoint: ParentCallbackEndpoint,
        body: Vec<u8>,
        timeout: Duration,
    ) -> Result<Response, ParentCallbackError> {
        self.http_client
            .post(self.endpoint_url(endpoint))
            .header("Content-Type", "application/json")
            .header(DISPATCH_TOKEN_HEADER, self.dispatch_token.as_ref())
            .timeout(timeout)
            .body(body)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    ParentCallbackError::RequestTimeout { endpoint }
                } else {
                    ParentCallbackError::RequestFailed { endpoint }
                }
            })
    }
}

#[derive(Serialize)]
struct ShellActionRequest {
    version: u8,
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
}

#[derive(Serialize)]
struct EventNotificationRequest {
    version: u8,
    #[serde(rename = "eventName")]
    event_name: &'static str,
    payload: Value,
}

fn encode_request<T: Serialize>(
    endpoint: ParentCallbackEndpoint,
    request: &T,
) -> Result<Vec<u8>, ParentCallbackError> {
    serde_json::to_vec(request).map_err(|_| ParentCallbackError::PayloadSerialization { endpoint })
}

fn parse_parent_shell_action_response(
    body: &[u8],
) -> Result<ParentShellActionResponse, ParentCallbackResponseError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| ParentCallbackResponseError::InvalidJson)?;
    let object = value
        .as_object()
        .ok_or(ParentCallbackResponseError::BodyNotObject)?;

    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .ok_or(ParentCallbackResponseError::VersionMissingOrInvalid)?;
    if version != u64::from(TRANSPORT_VERSION) {
        return Err(ParentCallbackResponseError::VersionMismatch);
    }

    let status = object
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
        .ok_or(ParentCallbackResponseError::StatusMissingOrInvalid)?;
    let success = object
        .get("success")
        .and_then(Value::as_bool)
        .ok_or(ParentCallbackResponseError::SuccessMissingOrInvalid)?;

    if success {
        return Ok(ParentShellActionResponse::Success {
            status,
            data: object.get("data").cloned(),
        });
    }

    let error = object
        .get("error")
        .and_then(Value::as_object)
        .ok_or(ParentCallbackResponseError::FailureErrorMissingOrInvalid)?;
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .ok_or(ParentCallbackResponseError::FailureCodeMissingOrInvalid)?
        .to_owned();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .ok_or(ParentCallbackResponseError::FailureMessageMissingOrInvalid)?
        .to_owned();

    Ok(ParentShellActionResponse::Failure {
        status,
        error: ParentCallbackErrorPayload { code, message },
    })
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, io, time::Duration};

    use serde_json::{Value, json};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        task::JoinHandle,
        time::{sleep, timeout},
    };

    use super::*;

    #[derive(Debug)]
    struct CapturedRequest {
        method: String,
        target: String,
        headers: HashMap<String, String>,
        body: Value,
    }

    #[tokio::test]
    async fn shell_action_sends_payload_auth_and_maps_success() {
        let (base_url, server) = spawn_server(
            http_response(
                "200 OK",
                r#"{"version":1,"success":true,"status":200,"data":{"accepted":true}}"#,
            ),
            None,
        )
        .await;
        let client = test_client(
            &base_url,
            "dispatch-secret",
            Duration::from_secs(1),
            Duration::from_secs(1),
        );

        let response = client
            .request_parent_shell_action(
                ParentShellAction::ShellOpenPath,
                Some(json!({ "path": "/tmp/report.txt" })),
            )
            .await
            .unwrap();

        assert_eq!(
            response,
            ParentShellActionResponse::Success {
                status: 200,
                data: Some(json!({ "accepted": true })),
            }
        );
        let request = server.await.unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, ParentCallbackEndpoint::ShellActions.path());
        assert_eq!(
            request.headers.get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(
            request.headers.get(DISPATCH_TOKEN_HEADER).unwrap(),
            "dispatch-secret"
        );
        assert_eq!(
            request.body,
            json!({
                "version": 1,
                "action": "shell_open_path",
                "payload": { "path": "/tmp/report.txt" }
            })
        );
    }

    #[tokio::test]
    async fn shell_action_maps_parent_failure_without_exposing_transport_details() {
        let (base_url, server) = spawn_server(
            http_response(
                "403 Forbidden",
                r#"{"version":1,"success":false,"status":403,"error":{"code":"FORBIDDEN","message":"dispatch denied"}}"#,
            ),
            None,
        )
        .await;
        let client = test_client(
            &base_url,
            "wrong-secret",
            Duration::from_secs(1),
            Duration::from_secs(1),
        );

        let response = client
            .request_parent_shell_action(ParentShellAction::GatewayRestart, None)
            .await
            .unwrap();
        assert_eq!(
            response,
            ParentShellActionResponse::Failure {
                status: 403,
                error: ParentCallbackErrorPayload {
                    code: "FORBIDDEN".to_owned(),
                    message: "dispatch denied".to_owned(),
                },
            }
        );
        assert_eq!(
            response.clone().into_application_data(),
            (403, json!({ "success": false, "error": "dispatch denied" }))
        );
        let request = server.await.unwrap();
        assert_eq!(
            request.body,
            json!({ "version": 1, "action": "gateway_restart" })
        );
        assert_eq!(
            request.headers.get(DISPATCH_TOKEN_HEADER).unwrap(),
            "wrong-secret"
        );
    }

    #[tokio::test]
    async fn notification_uses_contract_payload_and_ignores_response_body_and_status() {
        let (base_url, server) =
            spawn_server(http_response("500 Internal Server Error", "not-json"), None).await;
        let client = test_client(
            &base_url,
            "dispatch-secret",
            Duration::from_secs(1),
            Duration::from_secs(1),
        );

        let receipt = client
            .emit_parent_gateway_event(
                ParentGatewayEventName::GatewayError,
                json!({ "message": "gateway unavailable" }),
            )
            .await
            .unwrap();

        assert_eq!(receipt.endpoint(), ParentCallbackEndpoint::GatewayEvents);
        let request = server.await.unwrap();
        assert_eq!(request.target, ParentCallbackEndpoint::GatewayEvents.path());
        assert_eq!(
            request.body,
            json!({
                "version": 1,
                "eventName": "gateway:error",
                "payload": { "message": "gateway unavailable" }
            })
        );
    }

    #[tokio::test]
    async fn gateway_notification_is_explicitly_unsupported_and_does_not_send_callback() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut accept = tokio::spawn(async move { listener.accept().await });
        let client = test_client(
            &format!("http://{address}"),
            "dispatch-secret",
            Duration::from_secs(1),
            Duration::from_secs(1),
        );

        let error = client
            .emit_parent_gateway_event(
                ParentGatewayEventName::GatewayNotification,
                json!({ "message": "untrusted notification" }),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ParentCallbackError::GatewayNotificationUnsupported
        ));
        assert!(
            timeout(Duration::from_millis(50), &mut accept)
                .await
                .is_err()
        );
        accept.abort();
    }

    #[tokio::test]
    async fn incomplete_session_update_does_not_send_callback() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut accept = tokio::spawn(async move { listener.accept().await });
        let client = test_client(
            &format!("http://{address}"),
            "dispatch-secret",
            Duration::from_secs(1),
            Duration::from_secs(1),
        );

        let error = client
            .emit_parent_session_update(ParentSessionUpdateAvailability::Incomplete)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ParentCallbackError::SessionUpdateUnavailable {
                availability: ParentSessionUpdateAvailability::Incomplete,
            }
        ));
        assert!(
            timeout(Duration::from_millis(50), &mut accept)
                .await
                .is_err()
        );
        accept.abort();
    }

    #[test]
    fn shell_action_failure_preserves_parent_error_code_and_message() {
        let response = parse_parent_shell_action_response(
            br#"{"version":1,"status":403,"success":false,"error":{"code":"FORBIDDEN","message":"dispatch denied"}}"#,
        )
        .unwrap();
        assert_eq!(
            response,
            ParentShellActionResponse::Failure {
                status: 403,
                error: ParentCallbackErrorPayload {
                    code: "FORBIDDEN".to_owned(),
                    message: "dispatch denied".to_owned(),
                },
            }
        );
    }

    #[test]
    fn private_callback_state_stays_out_of_public_errors_and_application_data() {
        let private_base_url = "http://127.0.0.1:34100";
        let private_dispatch_token = "parent-dispatch-secret";
        let client = ParentCallbackClient::new(private_base_url, private_dispatch_token).unwrap();

        let projected = [
            format!(
                "{}",
                ParentCallbackError::RequestTimeout {
                    endpoint: ParentCallbackEndpoint::ShellActions,
                }
            ),
            format!(
                "{:?}",
                ParentCallbackError::RequestFailed {
                    endpoint: ParentCallbackEndpoint::GatewayEvents,
                }
            ),
            format!("{:?}", ParentCallbackConfigError::EmptyDispatchToken),
            format!(
                "{:?}",
                ParentCallbackDeliveryReceipt {
                    endpoint: ParentCallbackEndpoint::GatewayEvents,
                }
            ),
            serde_json::to_string(
                &ParentShellActionResponse::Failure {
                    status: 403,
                    error: ParentCallbackErrorPayload {
                        code: "FORBIDDEN".to_owned(),
                        message: "dispatch denied".to_owned(),
                    },
                }
                .into_application_data(),
            )
            .unwrap(),
        ];

        for value in projected {
            assert!(!value.contains(private_base_url));
            assert!(!value.contains(private_dispatch_token));
        }

        drop(client);
    }

    #[tokio::test]
    async fn callback_requests_report_timeouts_without_retrying() {
        let (base_url, server) = spawn_server(
            http_response("200 OK", r#"{"version":1,"success":true,"status":200}"#),
            Some(Duration::from_millis(100)),
        )
        .await;
        let client = test_client(
            &base_url,
            "dispatch-secret",
            Duration::from_millis(20),
            Duration::from_millis(20),
        );

        let error = client
            .request_parent_shell_action(ParentShellAction::GatewayRestart, None)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ParentCallbackError::RequestTimeout {
                endpoint: ParentCallbackEndpoint::ShellActions
            }
        ));
        let _ = server.await;

        let (base_url, server) = spawn_server(
            http_response("200 OK", "ignored"),
            Some(Duration::from_millis(100)),
        )
        .await;
        let client = test_client(
            &base_url,
            "dispatch-secret",
            Duration::from_secs(1),
            Duration::from_millis(20),
        );
        let error = client
            .emit_parent_gateway_event(ParentGatewayEventName::GatewayLifecycle, json!({}))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ParentCallbackError::RequestTimeout {
                endpoint: ParentCallbackEndpoint::GatewayEvents
            }
        ));
        let _ = server.await;
    }

    #[test]
    fn configuration_rejects_missing_or_invalid_credentials_and_base_url() {
        assert_eq!(
            ParentCallbackClient::new("", "dispatch-secret")
                .err()
                .unwrap(),
            ParentCallbackConfigError::EmptyBaseUrl
        );
        assert_eq!(
            ParentCallbackClient::new("not a URL", "dispatch-secret")
                .err()
                .unwrap(),
            ParentCallbackConfigError::InvalidBaseUrl
        );
        assert_eq!(
            ParentCallbackClient::new("ftp://127.0.0.1", "dispatch-secret")
                .err()
                .unwrap(),
            ParentCallbackConfigError::UnsupportedScheme
        );
        assert_eq!(
            ParentCallbackClient::new("http://", "dispatch-secret")
                .err()
                .unwrap(),
            ParentCallbackConfigError::InvalidBaseUrl
        );
        assert_eq!(
            ParentCallbackClient::new("http://127.0.0.1", "   ")
                .err()
                .unwrap(),
            ParentCallbackConfigError::EmptyDispatchToken
        );
    }

    #[test]
    fn allowlists_reject_unknown_names() {
        assert_eq!(
            ParentShellAction::try_from("provider_oauth_start").unwrap(),
            ParentShellAction::ProviderOauthStart
        );
        assert!(ParentShellAction::try_from("shell_execute").is_err());
        assert_eq!(
            ParentGatewayEventName::try_from("team:event").unwrap(),
            ParentGatewayEventName::TeamEvent
        );
        assert!(ParentGatewayEventName::try_from("team:unknown").is_err());
    }

    #[test]
    fn response_parser_strictly_validates_envelope_and_failure_fields() {
        let invalid_responses = [
            (
                br#"[]"#.as_slice(),
                ParentCallbackResponseError::BodyNotObject,
            ),
            (
                br#"{"version":2,"status":200,"success":true}"#.as_slice(),
                ParentCallbackResponseError::VersionMismatch,
            ),
            (
                br#"{"version":1,"status":"200","success":true}"#.as_slice(),
                ParentCallbackResponseError::StatusMissingOrInvalid,
            ),
            (
                br#"{"version":1,"status":200,"success":"true"}"#.as_slice(),
                ParentCallbackResponseError::SuccessMissingOrInvalid,
            ),
            (
                br#"{"version":1,"status":403,"success":false,"error":{}}"#.as_slice(),
                ParentCallbackResponseError::FailureCodeMissingOrInvalid,
            ),
            (
                br#"{"version":1,"status":403,"success":false,"error":{"code":"FORBIDDEN"}}"#
                    .as_slice(),
                ParentCallbackResponseError::FailureMessageMissingOrInvalid,
            ),
        ];
        for (body, reason) in invalid_responses {
            assert_eq!(parse_parent_shell_action_response(body), Err(reason));
        }
        assert_eq!(
            parse_parent_shell_action_response(br#"not-json"#),
            Err(ParentCallbackResponseError::InvalidJson)
        );
    }

    fn test_client(
        base_url: &str,
        dispatch_token: &str,
        shell_action_timeout: Duration,
        notification_timeout: Duration,
    ) -> ParentCallbackClient {
        ParentCallbackClient::with_timeouts(
            Url::parse(base_url).unwrap(),
            dispatch_token.to_owned(),
            Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("test parent callback HTTP client must build"),
            shell_action_timeout,
            notification_timeout,
        )
    }

    async fn spawn_server(
        response: String,
        response_delay: Option<Duration>,
    ) -> (String, JoinHandle<CapturedRequest>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut stream).await.unwrap();
            if let Some(delay) = response_delay {
                sleep(delay).await;
            }
            let _ = stream.write_all(response.as_bytes()).await;
            request
        });
        (format!("http://{address}"), server)
    }

    async fn read_http_request(stream: &mut TcpStream) -> io::Result<CapturedRequest> {
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut chunk = [0_u8; 4096];
            let count = stream.read(&mut chunk).await?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "request ended before headers",
                ));
            }
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break position;
            }
        };

        let header_text = String::from_utf8_lossy(&bytes[..header_end]);
        let mut lines = header_text.split("\r\n");
        let request_line = lines.next().unwrap_or_default();
        let mut request_parts = request_line.split_whitespace();
        let method = request_parts.next().unwrap_or_default().to_owned();
        let target = request_parts.next().unwrap_or_default().to_owned();
        let mut headers = HashMap::new();
        let mut content_length = 0_usize;
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                let name = name.to_ascii_lowercase();
                let value = value.trim().to_owned();
                if name == "content-length" {
                    content_length = value.parse().unwrap_or_default();
                }
                headers.insert(name, value);
            }
        }

        let body_start = header_end + 4;
        let body_end = body_start + content_length;
        while bytes.len() < body_end {
            let mut chunk = [0_u8; 4096];
            let count = stream.read(&mut chunk).await?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "request ended before body",
                ));
            }
            bytes.extend_from_slice(&chunk[..count]);
        }
        let body = serde_json::from_slice(&bytes[body_start..body_end])
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        Ok(CapturedRequest {
            method,
            target,
            headers,
            body,
        })
    }

    fn http_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }
}
