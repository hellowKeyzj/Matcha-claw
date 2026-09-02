mod connection;
mod events;
mod health;
mod recovery;
mod requests;
mod websocket;

#[cfg(test)]
mod tests;

use std::{
    fmt,
    net::SocketAddr,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use platform::endpoint::runtime_address::{RuntimeEndpoint, RuntimeScope, SessionIdentity};
use tokio::sync::{broadcast, mpsc};

use crate::{lifecycle::secret::Secret, protocol::wire::JsonRpcId, session::model::SessionId};

pub(crate) use self::events::{EventReplayPayload, RawEvent};
use self::{
    connection::{Connection, ExchangeFailure},
    events::{EventIngress, IngressError},
};
pub use self::{
    events::{EventReplay, EventSubscription, EventSubscriptionCursor},
    recovery::{EventRecovery, EventRecoveryCursor},
};
use super::{
    events::SessionEventUpdate,
    model::InitializeResult,
    request::{InitializeParams, ResponseError, decode_initialize_result, initialize_request},
};

pub(super) const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const CLIENT_NAME: &str = "matchaclaw-runtime-host";
const MAX_JSON_RPC_ID: u64 = 9_007_199_254_740_991;

static NEXT_JSON_RPC_ID: AtomicU64 = AtomicU64::new(1);

pub const RUNTIME_ADAPTER_ID: &str = "matcha-agent";
const APP_SERVER_AGENT_ID: &str = "app-server";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AppServerEndpoint(SocketAddr);

impl AppServerEndpoint {
    /// Creates a fixed loopback endpoint.
    ///
    /// # Errors
    ///
    /// Returns [`AppServerClientError::InvalidEndpoint`] for port zero or a
    /// non-loopback address.
    pub fn try_new(address: SocketAddr) -> Result<Self, AppServerClientError> {
        if address.port() == 0 || !address.ip().is_loopback() {
            return Err(AppServerClientError::InvalidEndpoint);
        }
        Ok(Self(address))
    }

    pub fn address(self) -> SocketAddr {
        self.0
    }

    pub fn runtime_endpoint(self) -> RuntimeEndpoint {
        RuntimeEndpoint::try_new(RUNTIME_ADAPTER_ID, self.0.to_string())
            .expect("validated app-server endpoint is a valid runtime identity")
    }

    pub fn runtime_scope(self) -> RuntimeScope {
        RuntimeScope::RuntimeInstance(self.runtime_endpoint())
    }

    pub fn session_identity(self, session_id: &SessionId) -> SessionIdentity {
        SessionIdentity::try_new(
            self.runtime_endpoint(),
            APP_SERVER_AGENT_ID,
            session_id.as_str(),
        )
        .expect("validated app-server session id is a valid runtime identity")
    }

    pub fn session_scope(self, session_id: &SessionId) -> RuntimeScope {
        RuntimeScope::Session(self.session_identity(session_id))
    }

    fn websocket_authority(self) -> String {
        self.0.to_string()
    }
}

pub struct AppServerClient {
    endpoint: AppServerEndpoint,
    connection: Connection,
    ingress: EventIngress,
}

impl AppServerClient {
    /// Checks `/health`, opens `/ws`, validates initialize v1, then closes.
    ///
    /// # Errors
    ///
    /// Returns a fixed error for deadline, transport, authentication, or
    /// protocol failure.
    pub async fn inspect_health_and_initialize(
        endpoint: AppServerEndpoint,
        secret: &Secret,
    ) -> Result<InitializeResult, AppServerClientError> {
        health::inspect_health(endpoint).await?;
        let (events, _receiver) = mpsc::channel(connection::EVENT_CHANNEL_CAPACITY);
        let (client, initialized) = Self::connect_and_initialize(endpoint, secret, events).await?;
        client.close().await?;
        Ok(initialized)
    }

    /// Opens authenticated `/ws` and validates initialize v1.
    ///
    /// # Errors
    ///
    /// Returns a fixed error for deadline, transport, authentication, or
    /// protocol failure.
    pub async fn connect_and_initialize(
        endpoint: AppServerEndpoint,
        secret: &Secret,
        events: mpsc::Sender<SessionEventUpdate>,
    ) -> Result<(Self, InitializeResult), AppServerClientError> {
        Self::connect_and_initialize_with_summary(endpoint, secret, Some(events)).await
    }

    pub(crate) async fn connect_and_initialize_raw_only(
        endpoint: AppServerEndpoint,
        secret: &Secret,
    ) -> Result<(Self, InitializeResult), AppServerClientError> {
        Self::connect_and_initialize_with_summary(endpoint, secret, None).await
    }

    async fn connect_and_initialize_with_summary(
        endpoint: AppServerEndpoint,
        secret: &Secret,
        updates: Option<mpsc::Sender<SessionEventUpdate>>,
    ) -> Result<(Self, InitializeResult), AppServerClientError> {
        let socket = websocket::connect(endpoint, secret).await?;
        let ingress = EventIngress::new(updates);
        let client = Self {
            endpoint,
            connection: Connection::new(socket, ingress.connection()),
            ingress,
        };

        let request = initialize_request(next_json_rpc_id()?, InitializeParams::new(CLIENT_NAME))
            .map_err(|_| AppServerClientError::Protocol)?;
        let expected_id = request.id.clone();
        let response = client
            .connection
            .exchange(request, REQUEST_DEADLINE)
            .await
            .map_err(AppServerClientError::from_exchange)?;
        let initialized = decode_initialize_result(&expected_id, response)
            .map_err(|_| AppServerClientError::InitializeFailed)?;
        Ok((client, initialized))
    }

    pub fn is_closed(&self) -> bool {
        self.connection.is_closed()
    }

    pub(crate) fn raw_events(&self) -> broadcast::Receiver<RawEvent> {
        self.ingress.connection().raw_events()
    }

    /// Sends close and joins the reader within a bounded deadline.
    ///
    /// # Errors
    ///
    /// Returns [`AppServerClientError::CloseFailed`] if close cannot be sent.
    pub async fn close(self) -> Result<(), AppServerClientError> {
        let Self {
            connection,
            ingress,
            ..
        } = self;
        let connection = connection.close().await;
        let ingress = ingress.close().await;
        connection.and(ingress.map_err(|_| AppServerClientError::CloseFailed))
    }

    pub(crate) async fn finish_with_cleanup<T>(self, outcome: T) -> T {
        outcome_after_cleanup(outcome, self.close().await)
    }
}

pub(crate) fn outcome_after_cleanup<T>(
    outcome: T,
    _cleanup: Result<(), AppServerClientError>,
) -> T {
    outcome
}

impl fmt::Debug for AppServerClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppServerClient")
            .field("endpoint", &self.endpoint)
            .field("closed", &self.connection.is_closed())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppServerClientError {
    InvalidEndpoint,
    HealthDeadline,
    HealthFailed,
    UpgradeDeadline,
    UpgradeFailed,
    InitializeFailed,
    RequestDeadline,
    ConnectionClosed,
    UnknownResponse,
    Transport,
    Protocol,
    PeerRejected,
    SessionNotFound,
    EventRecoveryRequired,
    CloseFailed,
}

impl AppServerClientError {
    fn from_exchange(failure: ExchangeFailure) -> Self {
        failure.into_client_error()
    }

    pub(super) fn from_response(error: ResponseError) -> Self {
        match error {
            ResponseError::Remote {
                session_not_found: true,
                ..
            } => Self::SessionNotFound,
            ResponseError::Remote {
                session_not_found: false,
                ..
            } => Self::PeerRejected,
            ResponseError::MismatchedId
            | ResponseError::InvalidResult { .. }
            | ResponseError::InvalidEvent => Self::Protocol,
        }
    }

    fn from_ingress(error: IngressError) -> Self {
        match error {
            IngressError::MismatchedSession | IngressError::NotPending => Self::Protocol,
            IngressError::Busy | IngressError::RecoveryRequired | IngressError::Closed => {
                Self::EventRecoveryRequired
            }
        }
    }
}

impl fmt::Display for AppServerClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidEndpoint => "app-server endpoint is invalid",
            Self::HealthDeadline => "app-server health deadline elapsed",
            Self::HealthFailed => "app-server health check failed",
            Self::UpgradeDeadline => "app-server WebSocket upgrade deadline elapsed",
            Self::UpgradeFailed => "app-server WebSocket upgrade failed",
            Self::InitializeFailed => "app-server initialize failed",
            Self::RequestDeadline => "app-server request deadline elapsed",
            Self::ConnectionClosed => "app-server connection closed",
            Self::UnknownResponse => "app-server returned an unknown response",
            Self::Transport => "app-server transport failed",
            Self::Protocol => "app-server protocol failed",
            Self::PeerRejected => "app-server rejected request",
            Self::SessionNotFound => "app-server session was not found",
            Self::EventRecoveryRequired => "app-server event recovery is required",
            Self::CloseFailed => "app-server close failed",
        })
    }
}

impl std::error::Error for AppServerClientError {}

pub(super) fn next_json_rpc_id() -> Result<JsonRpcId, AppServerClientError> {
    NEXT_JSON_RPC_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            (current < MAX_JSON_RPC_ID).then_some(current + 1)
        })
        .map(|id| JsonRpcId::Number(id.into()))
        .map_err(|_| AppServerClientError::Protocol)
}
