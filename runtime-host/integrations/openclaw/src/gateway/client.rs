use platform::state_dir::CanonicalStateDir;
use std::{
    collections::HashSet,
    fmt,
    future::Future,
    net::SocketAddr,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use foundation::execution::OwnedTask;
use futures_util::{SinkExt, StreamExt};
use platform::listener_identity::CertificateFingerprint;
use tokio::net::TcpStream;
use tokio::{
    sync::{Mutex, watch},
    time::{Instant, sleep, timeout, timeout_at},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Bytes, Message, Utf8Bytes},
};

use crate::{
    gateway::device_identity::{DeviceConnectPayloadContext, load_or_create_device_identity},
    session::{ingest::SessionEventIngest, protocol::SessionKey, trace},
};

use super::{
    auth::GatewaySecret,
    delivery::{DispatcherError, MutationDelivery},
    dispatcher::Dispatcher,
    observation::{Observations, OrderedContext, identity_key},
    wire,
};

const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(15);
const RPC_DEADLINE: Duration = Duration::from_secs(30);
const CLOSE_DEADLINE: Duration = Duration::from_secs(1);

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_CONTROL_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);

pub type GatewaySocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub struct GatewayControlSupervisor {
    client: GatewayClient,
    task: OwnedTask<()>,
}

impl GatewayControlSupervisor {
    fn is_finished(&self) -> bool {
        self.task.is_finished()
    }

    pub async fn dispose(mut self) {
        let _ = self.task.cancel_and_join().await;
        self.client.close_control_connection().await;
    }
}

struct ControlDispatcher {
    dispatcher: Dispatcher,
    epoch: Option<super::ingress::GatewayEpoch>,
    receive_task: StdMutex<Option<OwnedTask<()>>>,
    supports_goal: bool,
    metadata_subscription: StdMutex<Option<Result<(), sessions_module::ports::RuntimeOperationFailure>>>,
}

impl ControlDispatcher {
    async fn query<T>(
        &self,
        request: wire::RpcRequest,
        decode: fn(wire::GatewayResponse) -> Result<T, wire::WireError>,
    ) -> Result<T, GatewayClientError> {
        let response = self
            .dispatcher
            .query(request)
            .await
            .map_err(dispatcher_error)?;
        decode(response).map_err(|_| GatewayClientError::RpcFailed)
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct GatewayEndpoint(SocketAddr);

impl fmt::Debug for GatewayEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("GatewayEndpoint([REDACTED])")
    }
}

impl GatewayEndpoint {
    /// Creates a WebSocket endpoint restricted to a concrete loopback port.
    ///
    /// # Errors
    ///
    /// Returns [`GatewayClientError::InvalidEndpoint`] for port zero or a
    /// non-loopback address.
    pub fn try_new(address: SocketAddr) -> Result<Self, GatewayClientError> {
        if address.port() == 0 || !address.ip().is_loopback() {
            return Err(GatewayClientError::InvalidEndpoint);
        }
        Ok(Self(address))
    }

    pub fn address(self) -> SocketAddr {
        self.0
    }

    fn websocket_url(self) -> String {
        format!("ws://127.0.0.1:{}/ws", self.0.port())
    }

    fn http_url(self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.0.port())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayClientMetadata {
    version: String,
    platform: String,
}

impl GatewayClientMetadata {
    /// Creates the metadata sent by the trusted loopback backend client.
    ///
    /// # Errors
    ///
    /// Returns [`GatewayClientError::InvalidClientMetadata`] when either field
    /// is empty.
    pub fn try_new(version: String, platform: String) -> Result<Self, GatewayClientError> {
        if version.is_empty() || platform.is_empty() {
            return Err(GatewayClientError::InvalidClientMetadata);
        }
        Ok(Self { version, platform })
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn platform(&self) -> &str {
        &self.platform
    }
}

const CONTROL_TRANSIENT_RETRY_DELAYS: [Duration; 2] =
    [Duration::from_millis(20), Duration::from_millis(40)];
const CONTROL_STARTING_RETRY_DELAYS: [Duration; 6] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(8),
];

const CONTROL_SCOPES: [&str; 5] = [
    "operator.read",
    "operator.write",
    "operator.admin",
    "operator.approvals",
    "operator.questions",
];
const CONTROL_CAPS: [&str; 2] = ["agent-kind", "tool-events"];
const CONTROL_EVENTS: [&str; 1] = ["tick"];

#[derive(Clone, Debug, Eq, PartialEq)]
struct GatewayControlProfile {
    instance_id: String,
    scopes: Vec<&'static str>,
    capabilities: Vec<&'static str>,
}

impl GatewayControlProfile {
    fn new(instance_id: String) -> Self {
        Self {
            instance_id,
            scopes: CONTROL_SCOPES.to_vec(),
            capabilities: CONTROL_METHODS.to_vec(),
        }
    }

    fn instance_id(&self) -> &str {
        &self.instance_id
    }

    fn scopes(&self) -> &[&str] {
        &self.scopes
    }

    fn capabilities(&self) -> &[&str] {
        &self.capabilities
    }

    fn caps(&self) -> &[&str] {
        &CONTROL_CAPS
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GatewayControlStateView {
    instance_id: String,
    phase: GatewayControlPhase,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GatewayControlPhase {
    Idle,
    Connecting,
    Ready,
    Reconnecting,
    Unavailable,
    Closed,
}

enum GatewayControlConnectionState {
    Idle {
        instance_id: String,
    },
    Connecting {
        instance_id: String,
    },
    Ready {
        instance_id: String,
        control: Arc<ControlDispatcher>,
    },
    Reconnecting {
        instance_id: String,
    },
    Unavailable {
        instance_id: String,
        error: GatewayClientError,
    },
    Closed {
        instance_id: String,
    },
}

impl GatewayControlConnectionState {
    fn instance_id(&self) -> &str {
        match self {
            Self::Idle { instance_id }
            | Self::Connecting { instance_id, .. }
            | Self::Ready { instance_id, .. }
            | Self::Reconnecting { instance_id, .. }
            | Self::Unavailable { instance_id, .. }
            | Self::Closed { instance_id, .. } => instance_id,
        }
    }

    fn view(&self) -> GatewayControlStateView {
        GatewayControlStateView {
            instance_id: self.instance_id().to_owned(),
            phase: match self {
                Self::Idle { .. } => GatewayControlPhase::Idle,
                Self::Connecting { .. } => GatewayControlPhase::Connecting,
                Self::Ready { .. } => GatewayControlPhase::Ready,
                Self::Reconnecting { .. } => GatewayControlPhase::Reconnecting,
                Self::Unavailable { .. } => GatewayControlPhase::Unavailable,
                Self::Closed { .. } => GatewayControlPhase::Closed,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GatewayControlAttempt {
    index: usize,
}

impl GatewayControlAttempt {
    fn transient() -> Self {
        Self { index: 0 }
    }

    fn starting() -> Self {
        Self { index: 0 }
    }

    fn transient_retry_delay(self) -> Option<Duration> {
        CONTROL_TRANSIENT_RETRY_DELAYS.get(self.index).copied()
    }

    fn starting_retry_delay(self) -> Option<Duration> {
        CONTROL_STARTING_RETRY_DELAYS.get(self.index).copied()
    }

    fn next(self) -> Self {
        Self {
            index: self.index.saturating_add(1),
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GatewayControlSequenceAdvance {
    Accepted,
    Gap,
}

#[cfg(test)]
fn advance_control_sequence(
    last_sequence: &mut Option<u64>,
    next_sequence: Option<u64>,
) -> GatewayControlSequenceAdvance {
    let Some(next_sequence) = next_sequence else {
        return GatewayControlSequenceAdvance::Accepted;
    };
    match *last_sequence {
        Some(last_sequence) if next_sequence != last_sequence + 1 => {
            GatewayControlSequenceAdvance::Gap
        }
        _ => {
            *last_sequence = Some(next_sequence);
            GatewayControlSequenceAdvance::Accepted
        }
    }
}

#[derive(Clone)]
pub struct GatewayClient {
    endpoint: GatewayEndpoint,
    secret: Arc<GatewaySecret>,
    metadata: GatewayClientMetadata,
    control_profile: Arc<GatewayControlProfile>,
    control_state: Arc<Mutex<GatewayControlConnectionState>>,
    control_readiness: watch::Sender<u64>,
    control_readiness_sequence: Arc<AtomicU64>,
    control_supervisor: Arc<StdMutex<Option<GatewayControlSupervisor>>>,
    control_supervisor_started: Arc<AtomicBool>,
    control_ready_trace_emitted: Arc<AtomicBool>,
    live_goal_capability: Arc<AtomicBool>,
    state_dir: Option<CanonicalStateDir>,
    event_ingest: Option<Arc<SessionEventIngest>>,
    pub(crate) observations: Arc<Observations>,
}

impl GatewayClient {
    pub fn new(
        endpoint: GatewayEndpoint,
        certificate_fingerprint: CertificateFingerprint,
        secret: Arc<GatewaySecret>,
        metadata: GatewayClientMetadata,
    ) -> Self {
        Self::with_state_dir(endpoint, certificate_fingerprint, secret, metadata, None)
    }

    pub fn new_with_state_dir(
        endpoint: GatewayEndpoint,
        certificate_fingerprint: CertificateFingerprint,
        secret: Arc<GatewaySecret>,
        metadata: GatewayClientMetadata,
        state_dir: CanonicalStateDir,
    ) -> Self {
        Self::with_state_dir(
            endpoint,
            certificate_fingerprint,
            secret,
            metadata,
            Some(state_dir),
        )
    }

    fn with_state_dir(
        endpoint: GatewayEndpoint,
        _certificate_fingerprint: CertificateFingerprint,
        secret: Arc<GatewaySecret>,
        metadata: GatewayClientMetadata,
        state_dir: Option<CanonicalStateDir>,
    ) -> Self {
        let control_profile = Arc::new(GatewayControlProfile::new(next_control_instance_id()));
        let control_state = Arc::new(Mutex::new(GatewayControlConnectionState::Idle {
            instance_id: control_profile.instance_id().to_owned(),
        }));
        let (control_readiness, _) = watch::channel(0);
        Self {
            endpoint,
            secret,
            metadata,
            control_profile,
            control_state,
            control_readiness,
            control_readiness_sequence: Arc::new(AtomicU64::new(0)),
            control_supervisor: Arc::new(StdMutex::new(None)),
            control_supervisor_started: Arc::new(AtomicBool::new(false)),
            control_ready_trace_emitted: Arc::new(AtomicBool::new(false)),
            live_goal_capability: Arc::new(AtomicBool::new(false)),
            state_dir,
            event_ingest: None,
            observations: Observations::new(),
        }
    }

    pub(crate) fn supports_goal(&self) -> bool {
        self.live_goal_capability.load(Ordering::Acquire)
    }

    pub(crate) async fn goal_availability(&self) -> Result<(), sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        let state = self.control_state.lock().await;
        match &*state {
            GatewayControlConnectionState::Ready { control, .. } if control.supports_goal => Ok(()),
            GatewayControlConnectionState::Ready { .. } => Err(RuntimeOperationFailure::Unsupported),
            _ => Err(RuntimeOperationFailure::Unavailable),
        }
    }

    pub(crate) fn with_event_ingest(mut self, ingest: Arc<SessionEventIngest>) -> Self {
        self.event_ingest = Some(ingest);
        self
    }

    pub(crate) fn prepare_observation(&self, request: sessions_module::ports::SessionObservationRequest) -> Result<(), sessions_module::ports::RuntimeOperationFailure> {
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.prepare.request", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(&request.identity), "generation": request.generation,
                "ingestPresent": self.event_ingest.is_some() }));
        }
        if self.event_ingest.is_none() {
            if trace::enabled() {
                trace::log_unscoped("runtime.openclaw.observation.prepare.rejected", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&request.identity), "generation": request.generation, "reason": "ingest_missing" }));
            }
            return Err(sessions_module::ports::RuntimeOperationFailure::Unavailable);
        }
        self.observations.prepare(request)
    }

    async fn subscribe_observation(&self, control: &ControlDispatcher, identity: &sessions_module::state::SessionIdentity, generation: u64) -> Result<(), sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.subscribe.request", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                "sourceEpoch": control.epoch.map(|epoch| epoch.as_u64()) }));
        }
        let epoch = control.epoch.ok_or(RuntimeOperationFailure::Unavailable)?.as_u64();
        {
            let mut entries = self.observations.entries.lock().expect("observation registry lock poisoned");
            if trace::enabled() {
                let entry = entries.get(&identity_key(identity));
                trace::log_unscoped("runtime.openclaw.observation.subscribe.binding", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "sourceEpoch": epoch,
                    "entryPresent": entry.is_some(), "entryGeneration": entry.map(|entry| entry.generation),
                    "entrySourceEpoch": entry.and_then(|entry| entry.source_epoch), "subscribedEpoch": entry.and_then(|entry| entry.subscribed_epoch),
                    "paused": entry.map(|entry| entry.paused), "cursorPresent": entry.is_some_and(|entry| entry.cursor.is_some()) }));
            }
            let entry = entries.get_mut(&identity_key(identity)).filter(|entry| entry.generation == generation && entry.source_epoch.is_none_or(|source| source == epoch)).ok_or(RuntimeOperationFailure::Unavailable)?;
            if entry.subscribed_epoch == Some(epoch) {
                if trace::enabled() {
                    trace::log_unscoped("runtime.openclaw.observation.subscribe.reused", serde_json::json!({
                        "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "sourceEpoch": epoch, "paused": entry.paused }));
                }
                return Ok(());
            }
            entry.source_epoch = Some(epoch);
            entry.paused = false;
            if trace::enabled() {
                trace::log_unscoped("runtime.openclaw.observation.subscribe.admitted", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                    "sourceEpoch": entry.source_epoch, "subscribedEpoch": entry.subscribed_epoch, "paused": entry.paused }));
            }
        }
        let id = next_request_id("sessions-messages-subscribe");
        let request = wire::sessions_messages_subscribe_request(id.clone(), identity.session_key.clone(), identity.agent_id.clone()).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
        let (reply, result) = tokio::sync::oneshot::channel();
        self.observations.pending.lock().expect("observation pending lock poisoned").insert(id.clone(), OrderedContext::Subscribe { identity: identity.clone(), generation, reply });
        // ordered_query returns only after ordered ingress has decoded/projected the response; not pure socket IO.
        let ordered_started = trace::enabled().then(std::time::Instant::now);
        let response = control.dispatcher.ordered_query(request).await;
        let ordered_elapsed_ms = ordered_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
        self.observations.pending.lock().expect("observation pending lock poisoned").remove(&id);
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.subscribe.transport", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "sourceEpoch": epoch,
                "requestHash": sessions_module::trace::fingerprint(&id), "received": response.is_ok(),
                "orderedQueryElapsedMs": ordered_elapsed_ms, "timingScope": "dispatcher_queue_socket_and_ordered_ingress_including_trace" }));
        }
        response.map_err(|_| RuntimeOperationFailure::Unavailable)?;
        let reply_started = trace::enabled().then(std::time::Instant::now);
        let result = result.await.map_err(|_| RuntimeOperationFailure::Unavailable);
        let reply_elapsed_ms = reply_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
        if trace::enabled() {
            let entries = self.observations.entries.lock().expect("observation registry lock poisoned");
            let entry = entries.get(&identity_key(identity));
            trace::log_unscoped("runtime.openclaw.observation.subscribe.result", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "sourceEpoch": epoch,
                "requestHash": sessions_module::trace::fingerprint(&id), "replyReceived": result.is_ok(),
                "routerReplyWaitElapsedMs": reply_elapsed_ms, "timingScope": "router_reply_wait_after_ordered_query_excluding_outer_trace",
                "entryGeneration": entry.map(|entry| entry.generation), "entrySourceEpoch": entry.and_then(|entry| entry.source_epoch),
                "subscribedEpoch": entry.and_then(|entry| entry.subscribed_epoch), "paused": entry.map(|entry| entry.paused),
                "outcome": match &result { Ok(Ok(())) => "ok", Ok(Err(_)) => "native_failed", Err(_) => "reply_unavailable" },
                "failure": match &result { Ok(Err(failure)) | Err(failure) => Some(observation_failure_kind(failure)), _ => None } }));
        }
        result?
    }

    async fn describe_observation(&self, control: &ControlDispatcher, identity: &sessions_module::state::SessionIdentity, generation: u64) -> Result<(), sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        if control.supports_goal {
            let previous = *control.metadata_subscription.lock().expect("metadata subscription lock poisoned");
            let result = match previous {
                Some(result) => result,
                None => {
                    let result = async {
                        let request = wire::sessions_subscribe_request(next_request_id("sessions-subscribe")).map_err(|_| RuntimeOperationFailure::Unknown)?;
                        let response = control.dispatcher.ordered_query(request).await.map_err(|_| RuntimeOperationFailure::Unavailable)?;
                        wire::decode_sessions_subscribe(response).map_err(|_| RuntimeOperationFailure::Unknown)
                    }.await;
                    *control.metadata_subscription.lock().expect("metadata subscription lock poisoned") = Some(result);
                    result
                }
            };
            result?;
        }
        let id = next_request_id("sessions-describe");
        let key = SessionKey::try_new(identity.session_key.clone()).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
        let params = crate::session::protocol::SessionDescribeParams::new(key, Some(&identity.agent_id));
        let request = wire::session_request(id.clone(), crate::session::protocol::SESSIONS_DESCRIBE_METHOD, serde_json::to_value(params).map_err(|_| RuntimeOperationFailure::Unknown)?).map_err(|_| RuntimeOperationFailure::Unknown)?;
        let (reply, result) = tokio::sync::oneshot::channel();
        self.observations.pending.lock().expect("observation pending lock poisoned").insert(id.clone(), OrderedContext::Describe { identity: identity.clone(), generation, supported: control.supports_goal, reply });
        let response = control.dispatcher.ordered_query(request).await;
        self.observations.pending.lock().expect("observation pending lock poisoned").remove(&id);
        response.map_err(|_| RuntimeOperationFailure::Unavailable)?;
        result.await.map_err(|_| RuntimeOperationFailure::Unavailable)?
    }

    async fn history_observation(&self, control: &ControlDispatcher, identity: &sessions_module::state::SessionIdentity, generation: u64, page: crate::session::window::PageRequest, host_epoch: u64) -> Result<sessions_module::ports::SessionSync, sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        use crate::session::window::{self, Direction, PageRequest};
        let key = SessionKey::try_new(identity.session_key.clone()).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
        let params = crate::session::protocol::ChatHistoryParams::new(key).try_for_agent(identity.agent_id.clone()).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
        let paged = !matches!(page.direction(), Direction::Latest) || page.limit() == 0;
        let mut total = 0;
        let mut end = 0;
        let mut empty = false;
        if paged {
            let count_params = params.clone().try_with_limit(1).and_then(|params| params.try_with_offset(9_007_199_254_740_991))
                .map_err(|_| RuntimeOperationFailure::TargetRejected)?;
            let id = next_request_id("chat-history-count");
            let request = wire::session_request(id.clone(), crate::session::protocol::CHAT_HISTORY_METHOD, serde_json::to_value(count_params).map_err(|_| RuntimeOperationFailure::Unknown)?).map_err(|_| RuntimeOperationFailure::Unknown)?;
            let response = control.dispatcher.ordered_query(request).await.map_err(|_| RuntimeOperationFailure::Unavailable)?;
            let wire::GatewayResponse::Success { payload: Some(payload), .. } = response else { return Err(RuntimeOperationFailure::Unknown); };
            total = window::decode_total_messages(&payload).map_err(|_| RuntimeOperationFailure::Unknown)?;
            let requested = window::window_range(total, page);
            end = requested.end();
            empty = requested.start() == end;
        }
        let mut rebased = false;
        let mut resets = 0;
        for attempt in 0..4 {
            let mut cursor_reuse_reason = None;
            let mut entry_binding = None;
            let cursor = self.observations.entries.lock().expect("observation registry lock poisoned")
                .get(&identity_key(identity)).filter(|entry| entry.generation == generation).ok_or(RuntimeOperationFailure::Unavailable)
                .map(|entry| {
                    if trace::enabled() {
                        entry_binding = Some((entry.generation, entry.source_epoch));
                        cursor_reuse_reason = Some(if !matches!(page.direction(), crate::session::window::Direction::Latest) { "not_latest" }
                            else if entry.cursor.is_none() { "no_cursor" } else if entry.cursor_page != Some(page) { "page_mismatch" } else { "same_page" });
                    }
                    if entry.cursor_page == Some(page) { entry.cursor.clone() } else { None }
                })?;
            let request_trace = trace::enabled().then(|| serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                    "sourceEpoch": control.epoch.map(|epoch| epoch.as_u64()), "hostEpoch": host_epoch, "attempt": attempt + 1,
                    "direction": match page.direction() { crate::session::window::Direction::Latest => "latest", crate::session::window::Direction::Older => "older", crate::session::window::Direction::Newer => "newer" }, "limit": page.limit().max(1), "offset": page.offset(),
                    "cursorPresent": cursor.is_some(), "cursorHash": cursor.as_deref().map(sessions_module::trace::fingerprint),
                    "cursorSent": !paged && cursor.is_some(), "requestMode": if !paged && cursor.is_some() { "incremental" } else { "full" },
                    "paged": paged, "pageLimit": page.limit(),
                    "entryGeneration": entry_binding.map(|(generation, _)| generation), "entrySourceEpoch": entry_binding.and_then(|(_, epoch)| epoch),
                    "generationMatched": entry_binding.map(|(entry_generation, _)| entry_generation == generation),
                    "sourceEpochMatched": entry_binding.map(|(_, epoch)| epoch == control.epoch.map(|epoch| epoch.as_u64())),
                    "cursorReuseReason": cursor_reuse_reason }));
            let mut params = params.clone();
            let decode_page = if empty { PageRequest::new(page.direction(), 0, page.offset()).ok_or(RuntimeOperationFailure::TargetRejected)? } else { page };
            if paged {
                params = params.try_with_limit(if empty { 1 } else { PageRequest::MAX_LIMIT as u64 })
                    .and_then(|params| params.try_with_offset(if empty { 9_007_199_254_740_991 } else { total.saturating_sub(end) as u64 }))
                    .map_err(|_| RuntimeOperationFailure::TargetRejected)?;
            } else {
                params = params.try_with_limit(page.limit() as u64).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
                if let Some(cursor) = cursor { params = params.try_with_cursor(cursor).map_err(|_| RuntimeOperationFailure::TargetRejected)?; }
            }
            let id = next_request_id("chat-history");
            if let Some(mut payload) = request_trace {
                payload["requestHash"] = serde_json::json!(sessions_module::trace::fingerprint(&id));
                trace::log_unscoped("runtime.openclaw.observation.history.request", payload);
            }
            let request = wire::session_request(id.clone(), crate::session::protocol::CHAT_HISTORY_METHOD, serde_json::to_value(params).map_err(|_| RuntimeOperationFailure::Unknown)?).map_err(|_| RuntimeOperationFailure::Unknown)?;
            let (reply, result) = tokio::sync::oneshot::channel();
            self.observations.pending.lock().expect("observation pending lock poisoned").insert(id.clone(), OrderedContext::History { identity: identity.clone(), generation, page: decode_page, host_epoch, reply });
            // ordered_query returns only after ordered ingress has decoded/projected the response; not pure socket IO.
            let ordered_started = trace::enabled().then(std::time::Instant::now);
            let response = control.dispatcher.ordered_query(request).await;
            let ordered_elapsed_ms = ordered_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
            self.observations.pending.lock().expect("observation pending lock poisoned").remove(&id);
            if trace::enabled() {
                trace::log_unscoped("runtime.openclaw.observation.history.transport", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                    "sourceEpoch": control.epoch.map(|epoch| epoch.as_u64()), "hostEpoch": host_epoch, "attempt": attempt + 1,
                    "requestHash": sessions_module::trace::fingerprint(&id), "received": response.is_ok(),
                    "orderedQueryElapsedMs": ordered_elapsed_ms, "timingScope": "dispatcher_queue_socket_and_ordered_ingress_including_trace" }));
            }
            response.map_err(|_| RuntimeOperationFailure::Unavailable)?;
            let reply_started = trace::enabled().then(std::time::Instant::now);
            let result = async {
                match result.await.map_err(|_| RuntimeOperationFailure::Unavailable)?? {
                    crate::gateway::observation::HistoryRead::Projected(sync) => Ok(sync),
                    crate::gateway::observation::HistoryRead::NeedsContent { mut window, source_epoch } => {
                        crate::session::operation::SessionOperation::new(Arc::new(self.clone())).hydrate_history(identity, &mut window).await.map_err(|_| RuntimeOperationFailure::Unavailable)?;
                        self.event_ingest.as_ref().ok_or(RuntimeOperationFailure::Unavailable)?
                            .history_content(identity.clone(), generation, source_epoch, window, decode_page, host_epoch, Arc::clone(&self.observations)).await
                    }
                }
            }.await;
            let reply_elapsed_ms = reply_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
            if trace::enabled() {
                let entries = self.observations.entries.lock().expect("observation registry lock poisoned");
                let entry = entries.get(&identity_key(identity));
                trace::log_unscoped("runtime.openclaw.observation.history.result", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                    "sourceEpoch": control.epoch.map(|epoch| epoch.as_u64()), "hostEpoch": host_epoch, "attempt": attempt + 1,
                    "requestHash": sessions_module::trace::fingerprint(&id),
                    "routerReplyWaitElapsedMs": reply_elapsed_ms, "timingScope": "router_reply_wait_after_ordered_query_excluding_outer_trace",
                    "outcome": match &result { Ok(Some(_)) => "ok", Ok(None) => "reset", Err(_) => "native_failed" },
                    "failure": result.as_ref().err().map(observation_failure_kind),
                    "entryGeneration": entry.map(|entry| entry.generation), "entrySourceEpoch": entry.and_then(|entry| entry.source_epoch),
                    "paused": entry.map(|entry| entry.paused), "cursorPresent": entry.is_some_and(|entry| entry.cursor.is_some()),
                    "cursorHash": entry.and_then(|entry| entry.cursor.as_deref()).map(sessions_module::trace::fingerprint),
                    "sync": match &result { Ok(Some(sync)) => Some(sessions_module::trace::view_shape(&sync.view)), _ => None } }));
            }
            if let Some(sync) = result? {
                if paged && !empty {
                    let range = match &sync.view.window {
                        sessions_module::state::SessionFact::Complete(range) | sessions_module::state::SessionFact::Incomplete { facts: range, .. } => range,
                        _ => return Err(RuntimeOperationFailure::Unknown),
                    };
                    total = usize::try_from(range.total_item_count).map_err(|_| RuntimeOperationFailure::Unknown)?;
                    let requested = window::window_range(total, page);
                    let covered = if requested.start() == requested.end() {
                        range.window_start_offset == requested.start() as u64 && range.window_end_offset == requested.end() as u64
                    } else { match page.direction() {
                        Direction::Older => range.window_end_offset == requested.end() as u64 && range.window_start_offset < range.window_end_offset,
                        Direction::Newer => range.window_start_offset == requested.start() as u64 && range.window_end_offset > range.window_start_offset,
                        Direction::Latest => true,
                    } };
                    if !covered {
                        if rebased { return Err(RuntimeOperationFailure::Unknown); }
                        rebased = true;
                        end = match page.direction() {
                            Direction::Newer => requested.start().saturating_add(1).min(total),
                            _ => requested.end(),
                        };
                        continue;
                    }
                }
                return Ok(sync);
            }
            resets += 1;
            if trace::enabled() {
                trace::log_unscoped("runtime.openclaw.observation.history.reset", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                    "sourceEpoch": control.epoch.map(|epoch| epoch.as_u64()), "hostEpoch": host_epoch, "attempt": attempt + 1,
                    "retry": resets < 3 }));
            }
            if resets == 3 { break; }
        }
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.history.exhausted", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                "sourceEpoch": control.epoch.map(|epoch| epoch.as_u64()), "hostEpoch": host_epoch, "resets": resets, "rebased": rebased }));
        }
        Err(RuntimeOperationFailure::Unknown)
    }

    pub(crate) async fn sync_observation(&self, identity: &sessions_module::state::SessionIdentity, generation: u64, page: crate::session::window::PageRequest, host_epoch: u64) -> Result<sessions_module::ports::SessionSync, sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.sync.request", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "hostEpoch": host_epoch,
                "direction": match page.direction() { crate::session::window::Direction::Latest => "latest", crate::session::window::Direction::Older => "older", crate::session::window::Direction::Newer => "newer" }, "limit": page.limit(), "offset": page.offset() }));
        }
        let ingest = self.event_ingest.as_ref().ok_or(RuntimeOperationFailure::Unavailable)?;
        let read = ingest.history_started(identity.clone(), generation, page).await?;
        let result = async {
        let control = self.control_dispatcher().await.map_err(|_| {
            if trace::enabled() {
                trace::log_unscoped("runtime.openclaw.observation.sync.unavailable", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "hostEpoch": host_epoch, "reason": "control_unavailable" }));
            }
            RuntimeOperationFailure::Unavailable
        })?;
        let native_wait_started = trace::enabled().then(std::time::Instant::now);
        let _native = self.observations.native.lock().await;
        let native_wait_elapsed_ms = native_wait_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.sync.native_acquired", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "hostEpoch": host_epoch,
                "nativeMutexWaitElapsedMs": native_wait_elapsed_ms, "lockScope": "all_openclaw_observations",
                "timingScope": "native_mutex_lock_await_only" }));
        }
        let mut subscribe_elapsed_ms = None;
        let mut history_elapsed_ms = None;
        let result = async {
            let started = trace::enabled().then(std::time::Instant::now);
            let subscribed = self.subscribe_observation(&control, identity, generation).await;
            subscribe_elapsed_ms = started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
            subscribed?;
            self.describe_observation(&control, identity, generation).await?;
            let started = trace::enabled().then(std::time::Instant::now);
            let history = self.history_observation(&control, identity, generation, page, host_epoch).await;
            history_elapsed_ms = started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
            history
        }.await;
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.sync.result", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "hostEpoch": host_epoch,
                "sourceEpoch": control.epoch.map(|epoch| epoch.as_u64()), "succeeded": result.is_ok(),
                "nativeMutexWaitElapsedMs": native_wait_elapsed_ms, "subscribeWithTraceElapsedMs": subscribe_elapsed_ms,
                "historyWithTraceElapsedMs": history_elapsed_ms, "timingScope": "subscribe_and_history_calls_including_internal_trace_excluding_sync_result_trace",
                "failure": result.as_ref().err().map(observation_failure_kind),
                "syncSourceEpoch": result.as_ref().ok().and_then(|sync| sync.source_epoch),
                "cut": result.as_ref().ok().map(|sync| match sync.cut { sessions_module::ports::SessionSyncCut::Snapshot => "snapshot", sessions_module::ports::SessionSyncCut::EventFrontier { .. } => "event_frontier" }),
                "terminalRunCount": result.as_ref().ok().map(|sync| sync.terminal_runs.len()),
                "retiredItemCount": result.as_ref().ok().map(|sync| sync.retired_item_ids.len()) }));
        }
        result
        }.await;
        let retry_pending = ingest.history_finished(identity.clone(), generation, read).await;
        if result.is_err() && retry_pending { Err(RuntimeOperationFailure::HistoryRetryPending) } else { result }
    }

    pub(crate) async fn restart_observation(&self, identity: &sessions_module::state::SessionIdentity, generation: u64, next_generation: u64) -> Result<(), sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.restart.request", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "nextGeneration": next_generation }));
        }
        let _native = self.observations.native.lock().await;
        if !self.observations.contains(identity, generation, None) {
            if trace::enabled() {
                trace::log_unscoped("runtime.openclaw.observation.restart.rejected", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "nextGeneration": next_generation, "reason": "binding_unavailable" }));
            }
            return Err(RuntimeOperationFailure::Unavailable);
        }
        if next_generation <= generation || next_generation > 9_007_199_254_740_991 {
            if trace::enabled() {
                trace::log_unscoped("runtime.openclaw.observation.restart.rejected", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "nextGeneration": next_generation, "reason": "invalid_generation" }));
            }
            self.close_observation_locked(identity.clone(), generation).await;
            return Err(RuntimeOperationFailure::TargetRejected);
        }
        self.observations.restart(identity, generation, next_generation)?;
        self.observations.pending.lock().expect("observation pending lock poisoned").retain(|_, context| {
            let (target, target_generation) = match context {
                OrderedContext::Subscribe { identity, generation, .. } | OrderedContext::History { identity, generation, .. } | OrderedContext::Describe { identity, generation, .. } => (identity, generation),
            };
            target != identity || *target_generation != generation
        });
        let result = match &self.event_ingest {
            Some(ingest) => ingest.restart_observation(identity.clone(), generation, next_generation, Arc::clone(&self.observations)).await,
            None => Err(RuntimeOperationFailure::Unavailable),
        };
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.restart.handoff", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "nextGeneration": next_generation,
                "completed": result.is_ok(), "failure": result.as_ref().err().map(observation_failure_kind) }));
        }
        if result.is_err() {
            self.close_observation_locked(identity.clone(), next_generation).await;
            if let Some(ingest) = &self.event_ingest { ingest.close_observation(identity.clone(), generation).await; }
        }
        result
    }

    pub(crate) async fn close_observation(&self, identity: sessions_module::state::SessionIdentity, generation: u64) {
        let _native = self.observations.native.lock().await;
        self.close_observation_locked(identity, generation).await;
    }

    async fn close_observation_locked(&self, identity: sessions_module::state::SessionIdentity, generation: u64) {
        {
            let mut entries = self.observations.entries.lock().expect("observation registry lock poisoned");
            if trace::enabled() {
                let entry = entries.get(&identity_key(&identity));
                trace::log_unscoped("runtime.openclaw.observation.close.request", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                    "entryPresent": entry.is_some(), "entryGeneration": entry.map(|entry| entry.generation),
                    "sourceEpoch": entry.and_then(|entry| entry.source_epoch), "subscribedEpoch": entry.and_then(|entry| entry.subscribed_epoch),
                    "paused": entry.map(|entry| entry.paused), "cursorPresent": entry.is_some_and(|entry| entry.cursor.is_some()),
                    "cursorHash": entry.and_then(|entry| entry.cursor.as_deref()).map(sessions_module::trace::fingerprint),
                    "matchesGeneration": entry.is_some_and(|entry| entry.generation == generation) }));
            }
            if !entries.get(&identity_key(&identity)).is_some_and(|entry| entry.generation == generation) { return; }
            entries.remove(&identity_key(&identity));
        }
        self.observations.pending.lock().expect("observation pending lock poisoned").retain(|_, context| {
            let (target, target_generation) = match context {
                OrderedContext::Subscribe { identity, generation, .. } | OrderedContext::History { identity, generation, .. } | OrderedContext::Describe { identity, generation, .. } => (identity, generation),
            };
            *target != identity || *target_generation != generation
        });
        if let Some(ingest) = &self.event_ingest { ingest.close_observation(identity.clone(), generation).await; }
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.close.ingress_returned", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(&identity), "generation": generation, "ingestPresent": self.event_ingest.is_some() }));
        }
        if self.observations.entries.lock().expect("observation registry lock poisoned").contains_key(&identity_key(&identity)) {
            if trace::enabled() {
                trace::log_unscoped("runtime.openclaw.observation.close.unsubscribe_skipped", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&identity), "generation": generation, "reason": "binding_replaced" }));
            }
            return;
        }
        let control = {
            let state = self.control_state.lock().await;
            match &*state { GatewayControlConnectionState::Ready { control, .. } => Some(Arc::clone(control)), _ => None }
        };
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.close.unsubscribe", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(&identity), "generation": generation, "controlReady": control.is_some(),
                "sourceEpoch": control.as_ref().and_then(|control| control.epoch.map(|epoch| epoch.as_u64())) }));
        }
        if let Some(control) = control {
            if let Ok(request) = wire::sessions_messages_unsubscribe_request(next_request_id("sessions-messages-unsubscribe"), identity.session_key.clone(), identity.agent_id.clone()) {
                let result = control.dispatcher.query(request).await;
                if trace::enabled() {
                    trace::log_unscoped("runtime.openclaw.observation.close.result", serde_json::json!({
                        "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                        "sourceEpoch": control.epoch.map(|epoch| epoch.as_u64()),
                        "outcome": match &result { Ok(wire::GatewayResponse::Success { .. }) => "ok", Ok(wire::GatewayResponse::Failure { .. }) => "native_failed", Err(_) => "transport_failed" } }));
                }
            }
        }
    }

    pub fn control_ui_url(&self) -> String {
        let mut url = format!("http://{}/", self.endpoint.0);
        self.secret.append_url_fragment(&mut url);
        url
    }

    /// Connects with read scope and proves readiness through `hello-ok` and
    /// `system-presence` on one short-lived WebSocket.
    ///
    /// # Errors
    ///
    /// Returns a fixed [`GatewayClientError`] for endpoint, deadline,
    /// transport, authentication, or protocol failure.
    pub async fn connect_and_probe(&self) -> Result<(), GatewayClientError> {
        self.run_operation(wire::SYSTEM_PRESENCE_SCOPE, |socket| {
            Box::pin(async move {
                let request = wire::system_presence_request(next_request_id("presence"))
                    .map_err(|_| GatewayClientError::Protocol)?;
                let response = timeout(RPC_DEADLINE, exchange(socket, &request))
                    .await
                    .map_err(|_| GatewayClientError::RpcDeadline)??;
                wire::decode_system_presence(response)
                    .map(|_| ())
                    .map_err(|_| GatewayClientError::RpcFailed)
            })
        })
        .await
    }

    pub async fn http_ready(&self) -> bool {
        let healthz = http_status(self.endpoint.http_url("/healthz")).await;
        let readyz = http_status(self.endpoint.http_url("/readyz")).await;
        eprintln!(
            "[startup-trace] source=openclaw-gateway phase=http-ready detail=probe-results healthz={} readyz={}",
            healthz.map_or_else(|| "none".to_owned(), |status| status.to_string()),
            readyz.map_or_else(|| "none".to_owned(), |status| status.to_string())
        );
        healthz == Some(200) && readyz == Some(200)
    }

    pub async fn close_control_connection(&self) {
        let control = {
            let mut state = self.control_state.lock().await;
            self.live_goal_capability.store(false, Ordering::Release);
            let instance_id = state.instance_id().to_owned();
            let previous = std::mem::replace(
                &mut *state,
                GatewayControlConnectionState::Closed { instance_id },
            );
            match previous {
                GatewayControlConnectionState::Ready { control, .. } => Some(control),
                GatewayControlConnectionState::Idle { .. }
                | GatewayControlConnectionState::Connecting { .. }
                | GatewayControlConnectionState::Reconnecting { .. }
                | GatewayControlConnectionState::Unavailable { .. }
                | GatewayControlConnectionState::Closed { .. } => None,
            }
        };
        if let Some(control) = control {
            if let Ok(control) = Arc::try_unwrap(control) {
                let task = control.receive_task.lock().expect("control receive task lock poisoned").take();
                control.dispatcher.close().await;
                if let Some(mut task) = task { let _ = task.cancel_and_join().await; }
            }
        }
    }

    async fn ensure_control_ready(&self) -> Result<(), GatewayClientError> {
        self.ensure_control_supervision().await;
        loop {
            match self.control_readiness_result().await {
                Ok(()) => return Ok(()),
                Err(GatewayClientError::Starting) => {
                    let mut readiness = self.control_readiness();
                    let current = *readiness.borrow();
                    while *readiness.borrow() == current {
                        if !self.control_supervisor_started.load(Ordering::Acquire) {
                            return Err(GatewayClientError::Starting);
                        }
                        if readiness.changed().await.is_err() {
                            return Err(GatewayClientError::Starting);
                        }
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub async fn ensure_control_supervision(&self) {
        if matches!(
            *self.control_state.lock().await,
            GatewayControlConnectionState::Ready { .. }
                | GatewayControlConnectionState::Closed { .. }
        ) {
            return;
        }
        self.start_control_supervision();
    }

    pub fn start_control_supervision(&self) {
        let mut supervisor = self
            .control_supervisor
            .lock()
            .expect("gateway control supervisor lock poisoned");
        if supervisor
            .as_ref()
            .is_some_and(|supervisor| !supervisor.is_finished())
        {
            return;
        }
        if let Some(next) = self.spawn_control_supervisor() {
            *supervisor = Some(next);
        } else {
            supervisor.take();
        }
    }

    pub fn take_control_supervisor(&self) -> Option<GatewayControlSupervisor> {
        self.control_supervisor
            .lock()
            .expect("gateway control supervisor lock poisoned")
            .take()
    }

    fn spawn_control_supervisor(&self) -> Option<GatewayControlSupervisor> {
        if self
            .control_supervisor_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        let client = self.clone();
        let (task, _) = OwnedTask::spawn(|cancellation| async move {
            let cancelled = tokio::select! {
                _ = cancellation.cancelled() => true,
                _ = async {
                    loop {
                        client.connect_control_until_ready().await;
                        let control = {
                            let state = client.control_state.lock().await;
                            match &*state { GatewayControlConnectionState::Ready { control, .. } => Arc::clone(control), _ => break }
                        };
                        control.dispatcher.closed().await;
                        let receive_task = control.receive_task.lock().expect("control receive task lock poisoned").take();
                        if let Some(mut task) = receive_task { let _ = task.join().await; }
                        client.mark_control_reconnecting_if_current(&control).await;
                    }
                } => false,
            };
            if cancelled {
                client.close_control_connection().await;
            }
            client
                .control_supervisor_started
                .store(false, Ordering::Release);
            let phase = client.control_state.lock().await.view().phase;
            if !matches!(
                phase,
                GatewayControlPhase::Ready | GatewayControlPhase::Closed
            ) {
                client.bump_control_readiness();
            }
        });
        Some(GatewayControlSupervisor {
            client: self.clone(),
            task,
        })
    }

    pub async fn control_readiness_snapshot(&self) -> GatewayControlReadiness {
        self.ensure_control_supervision().await;
        match self.control_readiness_result().await {
            Ok(()) => GatewayControlReadiness::Ready,
            Err(error) => GatewayControlReadiness::from_connection_error(error),
        }
    }

    async fn control_readiness_result(&self) -> Result<(), GatewayClientError> {
        let snapshot = {
            let state = self.control_state.lock().await;
            match &*state {
                GatewayControlConnectionState::Ready { .. } => Ok(()),
                GatewayControlConnectionState::Closed { .. } => {
                    Err(GatewayClientError::ConnectionClosed)
                }
                GatewayControlConnectionState::Unavailable { error, .. } => Err(*error),
                GatewayControlConnectionState::Idle { .. }
                | GatewayControlConnectionState::Connecting { .. }
                | GatewayControlConnectionState::Reconnecting { .. } => {
                    Err(GatewayClientError::Starting)
                }
            }
        };
        if snapshot.is_ok() {
            self.send_control_heartbeat_if_due().await
        } else {
            snapshot
        }
    }

    async fn connect_control_until_ready(&self) {
        let mut attempt_number = 1_u32;
        let mut transient_attempt = GatewayControlAttempt::transient();
        let mut starting_attempt = GatewayControlAttempt::starting();
        let last_error = loop {
            eprintln!(
                "[startup-trace] source=openclaw-control phase=connecting detail=control-connect-attempt attempt={attempt_number}"
            );
            {
                let mut state = self.control_state.lock().await;
                if matches!(
                    *state,
                    GatewayControlConnectionState::Ready { .. }
                        | GatewayControlConnectionState::Closed { .. }
                ) {
                    return;
                }
                *state = GatewayControlConnectionState::Connecting {
                    instance_id: self.control_profile.instance_id().to_owned(),
                };
            }

            match self.connect_control_once().await {
                Ok((socket, hello)) => {
                    let _ = (
                        hello.server.connection_id,
                        hello.auth.scopes,
                        hello.policy.tick_interval_ms,
                    );
                    let (dispatcher, mut events) = Dispatcher::new(socket);
                    let (epoch, receive_task) = if let Some(ingest) = self.event_ingest.as_ref() {
                        let (epoch, task) = ingest.forward(events, Arc::clone(&self.observations), dispatcher.failure());
                        (Some(epoch), task)
                    } else {
                        let (task, _) = OwnedTask::spawn(|cancel| async move {
                            loop {
                                tokio::select! {
                                    _ = cancel.cancelled() => break,
                                    frame = events.recv() => match frame {
                                        Some(super::connection::GatewayFrame::Response { response, reply }) => { let _ = reply.send(Ok(response)); },
                                        Some(super::connection::GatewayFrame::Event(_)) => {},
                                        None => break,
                                    }
                                }
                            }
                        });
                        (None, task)
                    };
                    let supports_goal = hello.features.capabilities.iter().any(|capability| capability == crate::session::goal::START_CAPABILITY);
                    let control = Arc::new(ControlDispatcher { dispatcher, epoch, receive_task: StdMutex::new(Some(receive_task)), supports_goal, metadata_subscription: StdMutex::new(None) });
                    {
                        let mut state = self.control_state.lock().await;
                        self.live_goal_capability.store(supports_goal, Ordering::Release);
                        *state = GatewayControlConnectionState::Ready {
                            instance_id: self.control_profile.instance_id().to_owned(),
                            control,
                        };
                    };
                    self.trace_first_control_ready(attempt_number);
                    self.bump_control_readiness();
                    return;
                }
                Err(error) => {
                    eprintln!(
                        "[startup-trace] source=openclaw-control phase=connect-failed detail=control-connect-attempt-failed attempt={attempt_number} retryable={} error={error}",
                        is_retryable_control_connection_error(error)
                    );
                    if !is_retryable_control_connection_error(error) {
                        break error;
                    }
                    let delay = match error {
                        GatewayClientError::Starting => {
                            let Some(delay) = starting_attempt.starting_retry_delay() else {
                                break error;
                            };
                            starting_attempt = starting_attempt.next();
                            delay
                        }
                        _ => {
                            let Some(delay) = transient_attempt.transient_retry_delay() else {
                                break error;
                            };
                            transient_attempt = transient_attempt.next();
                            delay
                        }
                    };
                    *self.control_state.lock().await =
                        GatewayControlConnectionState::Reconnecting {
                            instance_id: self.control_profile.instance_id().to_owned(),
                        };
                    self.bump_control_readiness();
                    sleep(delay).await;
                    attempt_number = attempt_number.saturating_add(1);
                }
            }
        };

        eprintln!(
            "[startup-trace] source=openclaw-control phase=unavailable detail=control-connect-exhausted error={last_error}"
        );
        let terminal_state = GatewayControlConnectionState::Unavailable {
            instance_id: self.control_profile.instance_id().to_owned(),
            error: last_error,
        };
        *self.control_state.lock().await = terminal_state;
        self.bump_control_readiness();
    }

    async fn connect_control_once(
        &self,
    ) -> Result<(GatewaySocket, wire::HelloOk), GatewayClientError> {
        let (socket, hello) = self
            .connect_with_hello(self.control_profile.scopes())
            .await?;
        if has_methods(&hello.features.methods, self.control_profile.capabilities())
            && has_events(&hello.features.events, &CONTROL_EVENTS)
            && grants_requested_scopes(&hello.auth.scopes, self.control_profile.scopes())
        {
            Ok((socket, hello))
        } else {
            let mut socket = socket;
            close_quietly(&mut socket).await;
            Err(GatewayClientError::Protocol)
        }
    }

    async fn send_control_heartbeat_if_due(&self) -> Result<(), GatewayClientError> {
        if self.control_state.lock().await.view().phase == GatewayControlPhase::Ready {
            Ok(())
        } else {
            Err(GatewayClientError::Starting)
        }
    }

    fn trace_first_control_ready(&self, attempt: u32) {
        if self
            .control_ready_trace_emitted
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            eprintln!(
                "[startup-trace] source=openclaw-control phase=ready detail=first-control-ready attempt={attempt}"
            );
        }
    }

    fn bump_control_readiness(&self) {
        let sequence = self
            .control_readiness_sequence
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        let _ = self.control_readiness.send(sequence);
    }

    pub fn control_readiness(&self) -> watch::Receiver<u64> {
        self.control_readiness.subscribe()
    }

    #[cfg(test)]
    async fn control_state_view(&self) -> GatewayControlStateView {
        self.control_state.lock().await.view()
    }

    pub(crate) async fn observe_health(
        &self,
        probe: bool,
    ) -> Result<wire::GatewayHealthSnapshot, GatewayClientError> {
        self.run_control_query(
            wire::gateway_health_request(next_request_id("health"), probe)
                .map_err(|_| GatewayClientError::Protocol)?,
            wire::decode_gateway_health,
        )
        .await
    }

    pub(crate) async fn observe_status(
        &self,
        include_channel_summary: bool,
    ) -> Result<wire::GatewayStatusSnapshot, GatewayClientError> {
        self.run_control_query(
            wire::gateway_status_request(next_request_id("status"), include_channel_summary)
                .map_err(|_| GatewayClientError::Protocol)?,
            wire::decode_gateway_status,
        )
        .await
    }

    pub(crate) async fn observe_mcp_server_status(
        &self,
        session_key: String,
    ) -> Result<wire::McpServerStatusList, GatewayClientError> {
        let mut cursor = None;
        let mut seen_cursors = HashSet::new();
        let mut servers = Vec::new();
        loop {
            let request = wire::mcp_server_status_list_request(
                next_request_id("mcp-status"),
                session_key.clone(),
                cursor.clone(),
            )
            .map_err(|_| GatewayClientError::Protocol)?;
            let page = self
                .run_gateway_query(request, wire::decode_mcp_server_status_list)
                .await?;
            servers.extend(page.servers);
            let Some(next_cursor) = page.next_cursor else {
                break;
            };
            if !seen_cursors.insert(next_cursor.clone()) {
                return Err(GatewayClientError::RpcFailed);
            }
            cursor = Some(next_cursor);
        }
        Ok(wire::McpServerStatusList {
            servers,
            next_cursor: None,
        })
    }

    pub(crate) async fn set_mcp_session_server_enabled(
        &self,
        session_key: String,
        server_name: String,
        enabled: bool,
    ) -> Result<(), GatewayClientError> {
        self.run_gateway_query(
            wire::mcp_session_servers_update_request(
                next_request_id("mcp-update"),
                session_key,
                server_name,
                enabled,
            )
            .map_err(|_| GatewayClientError::Protocol)?,
            wire::decode_mcp_session_servers_update,
        )
        .await
    }

    pub(crate) async fn tail_logs(
        &self,
        cursor: Option<u64>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<wire::GatewayLogsTail, GatewayClientError> {
        self.run_gateway_query(
            wire::gateway_logs_tail_request(next_request_id("logs"), cursor, limit, max_bytes)
                .map_err(|_| GatewayClientError::Protocol)?,
            wire::decode_gateway_logs_tail,
        )
        .await
    }

    async fn run_gateway_query<T>(
        &self,
        request: wire::RpcRequest,
        decode: fn(wire::GatewayResponse) -> Result<T, wire::WireError>,
    ) -> Result<T, GatewayClientError> {
        self.run_retriable_control_query(request, decode).await
    }

    async fn run_control_query<T>(
        &self,
        request: wire::RpcRequest,
        decode: fn(wire::GatewayResponse) -> Result<T, wire::WireError>,
    ) -> Result<T, GatewayClientError> {
        self.run_retriable_control_query(request, decode).await
    }

    async fn run_retriable_control_query<T>(
        &self,
        request: wire::RpcRequest,
        decode: fn(wire::GatewayResponse) -> Result<T, wire::WireError>,
    ) -> Result<T, GatewayClientError> {
        let control = self.control_dispatcher().await?;
        match control.query(request.clone(), decode).await {
            Ok(result) => Ok(result),
            Err(error) if is_retryable_control_connection_error(error) => {
                self.mark_control_reconnecting_if_current(&control).await;
                let control = self.control_dispatcher().await?;
                control.query(request, decode).await
            }
            Err(error) => Err(error),
        }
    }

    async fn mark_control_reconnecting_if_current(&self, current: &Arc<ControlDispatcher>) {
        current.dispatcher.disconnect().await;
        let receive_task = current.receive_task.lock().expect("control receive task lock poisoned").take();
        if let Some(mut task) = receive_task { let _ = task.join().await; }
        let mut state = self.control_state.lock().await;
        let instance_id = state.instance_id().to_owned();
        if let GatewayControlConnectionState::Ready { control, .. } = &*state {
            if Arc::ptr_eq(control, current) {
                self.live_goal_capability.store(false, Ordering::Release);
                *state = GatewayControlConnectionState::Reconnecting { instance_id };
            }
        }
    }

    async fn control_dispatcher(&self) -> Result<Arc<ControlDispatcher>, GatewayClientError> {
        self.ensure_control_ready().await?;
        let state = self.control_state.lock().await;
        let GatewayControlConnectionState::Ready { control, .. } = &*state else {
            return Err(GatewayClientError::Starting);
        };
        Ok(Arc::clone(control))
    }

    /// Observes whether the Gateway exposes the fixed Host control contract.
    pub async fn observe_control(&self) -> GatewayControlReadiness {
        match self.ensure_control_ready().await {
            Ok(()) => GatewayControlReadiness::Ready,
            Err(error) => GatewayControlReadiness::from_connection_error(error),
        }
    }

    async fn run_operation<F>(&self, scope: &str, operation: F) -> Result<(), GatewayClientError>
    where
        F: for<'socket> FnOnce(
            &'socket mut GatewaySocket,
        ) -> std::pin::Pin<
            Box<dyn Future<Output = Result<(), GatewayClientError>> + Send + 'socket>,
        >,
    {
        let mut socket = match self.connect(&[scope]).await {
            Ok(socket) => socket,
            Err(error) => return Err(error),
        };
        let result = operation(&mut socket).await;
        close_quietly(&mut socket).await;
        result
    }

    pub(crate) async fn connect_cron_execution(&self) -> Result<GatewaySocket, GatewayClientError> {
        self.connect_versioned_methods_and_events(
            &[wire::GATEWAY_CRON_ADMIN_SCOPE],
            &[wire::cron::CRON_RUN_METHOD],
            &["cron"],
        )
        .await
    }

    async fn connect_versioned_methods_and_events(
        &self,
        scopes: &[&str],
        methods: &[&str],
        events: &[&str],
    ) -> Result<GatewaySocket, GatewayClientError> {
        let (socket, hello) = self.connect_with_hello(scopes).await?;
        if has_methods(&hello.features.methods, methods)
            && has_events(&hello.features.events, events)
        {
            Ok(socket)
        } else {
            let mut socket = socket;
            close_quietly(&mut socket).await;
            Err(GatewayClientError::Protocol)
        }
    }

    pub(crate) async fn question_list(&self) -> Result<wire::GatewayResponse, GatewayClientError> {
        let request = wire::question_list_request(next_request_id("question-list"))
            .map_err(|_| GatewayClientError::RpcFailed)?;
        self.rpc_query(request).await
    }

    pub(crate) async fn question_get(&self, id: String) -> Result<wire::GatewayResponse, GatewayClientError> {
        let request = wire::question_get_request(next_request_id("question-get"), id)
            .map_err(|_| GatewayClientError::RpcFailed)?;
        self.rpc_query(request).await
    }

    pub(crate) async fn rpc_ordered_query(&self, request: wire::RpcRequest) -> Result<wire::GatewayResponse, GatewayClientError> {
        self.control_dispatcher().await?.dispatcher.ordered_query(request).await.map_err(dispatcher_error)
    }

    pub(crate) async fn rpc_query(
        &self,
        request: wire::RpcRequest,
    ) -> Result<wire::GatewayResponse, GatewayClientError> {
        self.rpc_query_with_deadline(request, RPC_DEADLINE).await
    }

    pub(crate) async fn rpc_query_with_deadline(
        &self,
        request: wire::RpcRequest,
        deadline: Duration,
    ) -> Result<wire::GatewayResponse, GatewayClientError> {
        let control = self.control_dispatcher().await?;
        match control
            .dispatcher
            .query_with_deadline(request.clone(), deadline)
            .await
            .map_err(dispatcher_error)
        {
            Ok(response) => Ok(response),
            Err(error) if is_retryable_control_connection_error(error) => {
                self.mark_control_reconnecting_if_current(&control).await;
                let control = self.control_dispatcher().await?;
                control
                    .dispatcher
                    .query_with_deadline(request, deadline)
                    .await
                    .map_err(dispatcher_error)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn rpc_mutation(&self, request: wire::RpcRequest) -> MutationDelivery {
        let control = match self.control_dispatcher().await {
            Ok(control) => control,
            Err(error) => {
                return MutationDelivery::NotWritten(client_error_to_dispatcher_error(error));
            }
        };
        let delivery = control.dispatcher.mutate(request.clone()).await;
        if let MutationDelivery::NotWritten(error) = delivery {
            if is_retryable_control_connection_error(dispatcher_error(error)) {
                self.mark_control_reconnecting_if_current(&control).await;
                let control = match self.control_dispatcher().await {
                    Ok(control) => control,
                    Err(error) => {
                        return MutationDelivery::NotWritten(client_error_to_dispatcher_error(
                            error,
                        ));
                    }
                };
                return control.dispatcher.mutate(request).await;
            }
        }
        delivery
    }

    pub(crate) async fn rpc_goal_mutation(&self, request: wire::RpcRequest) -> Result<MutationDelivery, sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        for attempt in 0..2 {
            let control = self.control_dispatcher().await.map_err(|_| RuntimeOperationFailure::Unavailable)?;
            if !control.supports_goal { return Err(RuntimeOperationFailure::Unsupported); }
            let delivery = control.dispatcher.mutate(request.clone()).await;
            if attempt == 0 {
                if let MutationDelivery::NotWritten(error) = delivery {
                    if is_retryable_control_connection_error(dispatcher_error(error)) {
                        self.mark_control_reconnecting_if_current(&control).await;
                        continue;
                    }
                }
            }
            return Ok(delivery);
        }
        unreachable!("Goal mutation attempts are bounded")
    }

    pub(crate) async fn rpc_encoded_mutation(
        &self,
        request_id: String,
        encoded: String,
    ) -> MutationDelivery {
        self.rpc_encoded_mutation_with_deadline(request_id, encoded, RPC_DEADLINE)
            .await
    }

    pub(crate) async fn rpc_encoded_mutation_with_deadline(
        &self,
        request_id: String,
        encoded: String,
        deadline: Duration,
    ) -> MutationDelivery {
        let control = match self.control_dispatcher().await {
            Ok(control) => control,
            Err(error) => {
                return MutationDelivery::NotWritten(client_error_to_dispatcher_error(error));
            }
        };
        let delivery = control
            .dispatcher
            .mutate_encoded(request_id.clone(), encoded.clone(), deadline)
            .await;
        if let MutationDelivery::NotWritten(error) = delivery {
            if is_retryable_control_connection_error(dispatcher_error(error)) {
                self.mark_control_reconnecting_if_current(&control).await;
                let control = match self.control_dispatcher().await {
                    Ok(control) => control,
                    Err(error) => {
                        return MutationDelivery::NotWritten(client_error_to_dispatcher_error(
                            error,
                        ));
                    }
                };
                return control
                    .dispatcher
                    .mutate_encoded(request_id, encoded, deadline)
                    .await;
            }
        }
        delivery
    }

    async fn connect(&self, scopes: &[&str]) -> Result<GatewaySocket, GatewayClientError> {
        self.connect_with_hello(scopes)
            .await
            .map(|(socket, _)| socket)
    }

    async fn connect_with_hello(
        &self,
        scopes: &[&str],
    ) -> Result<(GatewaySocket, wire::HelloOk), GatewayClientError> {
        let deadline = handshake_deadline(Instant::now());
        let endpoint = self.endpoint.websocket_url();
        let (mut socket, _) = timeout_at(deadline, connect_async(endpoint.as_str()))
            .await
            .map_err(|_| GatewayClientError::UpgradeDeadline)?
            .map_err(|_| GatewayClientError::UpgradeFailed)?;

        let challenge = match timeout_at(deadline, receive_challenge(&mut socket)).await {
            Ok(Ok(challenge)) => challenge,
            Ok(Err(error)) => {
                close_quietly(&mut socket).await;
                return Err(error);
            }
            Err(_) => {
                close_quietly(&mut socket).await;
                return Err(GatewayClientError::ChallengeDeadline);
            }
        };
        let requested_scopes = scopes.to_vec();
        let scopes = scopes
            .iter()
            .map(|scope| (*scope).to_owned())
            .collect::<Vec<_>>();
        let device = if let Some(state_dir) = &self.state_dir {
            let signed_at_ms = challenge.timestamp_ms;
            let identity = load_or_create_device_identity(state_dir, signed_at_ms)
                .map_err(|_| GatewayClientError::Authentication)?;
            let signed = self
                .secret
                .with_token(|token| {
                    identity.sign_connect_device_payload(DeviceConnectPayloadContext {
                        client_id: "gateway-client",
                        client_mode: "backend",
                        role: "operator",
                        scopes: &requested_scopes,
                        signed_at_ms,
                        token: Some(token),
                        nonce: &challenge.nonce,
                        platform: Some(self.metadata.platform()),
                        device_family: Some("desktop"),
                    })
                })
                .map_err(|_| GatewayClientError::Authentication)?;
            Some(wire::ConnectDevice {
                id: signed.id().to_owned(),
                public_key: signed.public_key().to_owned(),
                signature: signed.signature().to_owned(),
                signed_at: signed.signed_at(),
                nonce: signed.nonce().to_owned(),
            })
        } else {
            None
        };
        let request = wire::build_backend_connect_request(
            next_request_id("connect"),
            challenge.nonce,
            self.secret
                .issue_gateway_token()
                .map_err(|_| GatewayClientError::Authentication)?,
            wire::ConnectParams {
                client: wire::ConnectClient {
                    version: self.metadata.version.clone(),
                    platform: self.metadata.platform.clone(),
                    display_name: Some("MatchaClaw Runtime Host".into()),
                    device_family: Some("desktop".into()),
                    instance_id: Some(self.control_profile.instance_id().to_owned()),
                },
                scopes,
                caps: self
                    .control_profile
                    .caps()
                    .iter()
                    .map(|cap| (*cap).to_owned())
                    .collect(),
                device,
            },
        )
        .map_err(|_| GatewayClientError::Protocol)?;
        let request_id = request.request_id().to_owned();
        let encoded = request.encode().map_err(|_| GatewayClientError::Protocol)?;
        drop(request);

        let response = match timeout_at(deadline, async {
            send_sensitive_text(&mut socket, encoded).await?;
            receive_response(&mut socket, &request_id).await
        })
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                close_quietly(&mut socket).await;
                return Err(error);
            }
            Err(_) => {
                close_quietly(&mut socket).await;
                return Err(GatewayClientError::ConnectDeadline);
            }
        };
        let hello = match response {
            wire::GatewayResponse::Failure { error, .. } if error.startup_sidecars => {
                close_quietly(&mut socket).await;
                return Err(GatewayClientError::Starting);
            }
            response => match wire::decode_hello_ok(response) {
                Ok(hello) => hello,
                Err(_) => {
                    close_quietly(&mut socket).await;
                    return Err(GatewayClientError::ConnectFailed);
                }
            },
        };
        if hello.auth.role != "operator"
            || !grants_requested_scopes(&hello.auth.scopes, &requested_scopes)
        {
            close_quietly(&mut socket).await;
            return Err(GatewayClientError::ConnectFailed);
        }
        Ok((socket, hello))
    }
}

const CONTROL_METHODS: [&str; 13] = [
    "status",
    "config.get",
    "config.patch",
    "config.apply",
    "plugins.refresh",
    "agents.list",
    "skills.status",
    "channels.pairing.list",
    "sessions.describe",
    "question.list",
    "question.get",
    wire::QUESTION_RESOLVE_METHOD,
    wire::SYSTEM_PRESENCE_METHOD,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatewayControlReadiness {
    Ready,
    Starting,
    Unavailable,
}

impl GatewayControlReadiness {
    fn from_connection_error(error: GatewayClientError) -> Self {
        match error {
            GatewayClientError::UpgradeDeadline
            | GatewayClientError::UpgradeFailed
            | GatewayClientError::ChallengeDeadline
            | GatewayClientError::ConnectDeadline
            | GatewayClientError::Starting
            | GatewayClientError::RpcDeadline
            | GatewayClientError::Transport => Self::Starting,
            GatewayClientError::ConnectionClosed => Self::Unavailable,
            GatewayClientError::InvalidEndpoint
            | GatewayClientError::InvalidClientMetadata
            | GatewayClientError::Authentication
            | GatewayClientError::ChallengeFailed
            | GatewayClientError::ConnectFailed
            | GatewayClientError::RpcFailed
            | GatewayClientError::Protocol
            | GatewayClientError::SecretCleanupFailed => Self::Unavailable,
        }
    }
}

fn observation_failure_kind(failure: &sessions_module::ports::RuntimeOperationFailure) -> &'static str {
    use sessions_module::ports::RuntimeOperationFailure;
    match failure {
        RuntimeOperationFailure::Unsupported => "unsupported",
        RuntimeOperationFailure::Unavailable => "unavailable",
        RuntimeOperationFailure::TargetRejected => "target_rejected",
        RuntimeOperationFailure::Unknown => "unknown",
        RuntimeOperationFailure::HistoryRetryPending => "history_retry_pending",
    }
}

fn is_retryable_control_connection_error(error: GatewayClientError) -> bool {
    matches!(
        error,
        GatewayClientError::UpgradeDeadline
            | GatewayClientError::UpgradeFailed
            | GatewayClientError::ChallengeDeadline
            | GatewayClientError::ConnectDeadline
            | GatewayClientError::Starting
            | GatewayClientError::RpcDeadline
            | GatewayClientError::ConnectionClosed
            | GatewayClientError::Transport
    )
}

fn has_methods(advertised: &[String], required: &[&str]) -> bool {
    required
        .iter()
        .all(|required| advertised.iter().any(|method| method == required))
}

fn has_events(advertised: &[String], required: &[&str]) -> bool {
    required
        .iter()
        .all(|required| advertised.iter().any(|event| event == required))
}

fn grants_requested_scopes(granted: &[String], requested: &[&str]) -> bool {
    requested.iter().all(|scope| {
        granted.iter().any(|granted_scope| granted_scope == scope)
            || (scope == &"operator.read"
                && granted
                    .iter()
                    .any(|granted_scope| granted_scope == "operator.write"))
            || granted
                .iter()
                .any(|granted_scope| granted_scope == "operator.admin")
    })
}

async fn http_status(url: String) -> Option<u16> {
    let response = reqwest::get(url).await.ok()?;
    Some(response.status().as_u16())
}

fn handshake_deadline(started_at: Instant) -> Instant {
    started_at + HANDSHAKE_DEADLINE
}

impl fmt::Debug for GatewayClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayClient")
            .field("endpoint", &self.endpoint)
            .field("secret", &self.secret)
            .field("metadata", &self.metadata)
            .field("control_profile", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatewayClientError {
    InvalidEndpoint,
    InvalidClientMetadata,
    Authentication,
    UpgradeDeadline,
    UpgradeFailed,
    ChallengeDeadline,
    ChallengeFailed,
    ConnectDeadline,
    Starting,
    ConnectFailed,
    RpcDeadline,
    RpcFailed,
    ConnectionClosed,
    Transport,
    Protocol,
    SecretCleanupFailed,
}

impl fmt::Display for GatewayClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidEndpoint => "gateway endpoint is invalid",
            Self::InvalidClientMetadata => "gateway client metadata is invalid",
            Self::Authentication => "gateway authentication failed",
            Self::UpgradeDeadline => "gateway WebSocket upgrade deadline elapsed",
            Self::UpgradeFailed => "gateway WebSocket upgrade failed",
            Self::ChallengeDeadline => "gateway challenge deadline elapsed",
            Self::ChallengeFailed => "gateway challenge failed",
            Self::ConnectDeadline => "gateway connect deadline elapsed",
            Self::Starting => "gateway is starting",
            Self::ConnectFailed => "gateway connect failed",
            Self::RpcDeadline => "gateway RPC deadline elapsed",
            Self::RpcFailed => "gateway RPC failed",
            Self::ConnectionClosed => "gateway connection closed",
            Self::Transport => "gateway transport failed",
            Self::Protocol => "gateway protocol failed",
            Self::SecretCleanupFailed => "gateway secret cleanup failed",
        })
    }
}

impl std::error::Error for GatewayClientError {}

fn dispatcher_error(error: DispatcherError) -> GatewayClientError {
    match error {
        DispatcherError::Deadline => GatewayClientError::RpcDeadline,
        DispatcherError::ConnectionClosed => GatewayClientError::ConnectionClosed,
        DispatcherError::Transport => GatewayClientError::Transport,
        DispatcherError::Protocol
        | DispatcherError::EventBackpressure
        | DispatcherError::Saturated => GatewayClientError::Protocol,
    }
}

fn client_error_to_dispatcher_error(error: GatewayClientError) -> DispatcherError {
    match error {
        GatewayClientError::RpcDeadline => DispatcherError::Deadline,
        GatewayClientError::ConnectionClosed => DispatcherError::ConnectionClosed,
        GatewayClientError::Transport => DispatcherError::Transport,
        _ => DispatcherError::Protocol,
    }
}

async fn receive_challenge(
    socket: &mut GatewaySocket,
) -> Result<wire::ConnectChallenge, GatewayClientError> {
    loop {
        match receive_message(socket).await? {
            Message::Text(text) => {
                return wire::decode_challenge(text.as_str())
                    .map_err(|_| GatewayClientError::ChallengeFailed);
            }
            Message::Ping(payload) => send_pong(socket, payload).await?,
            Message::Pong(_) => {}
            Message::Close(_) => return Err(GatewayClientError::ConnectionClosed),
            Message::Binary(_) | Message::Frame(_) => {
                return Err(GatewayClientError::ChallengeFailed);
            }
        }
    }
}

async fn exchange(
    socket: &mut GatewaySocket,
    request: &wire::RpcRequest,
) -> Result<wire::GatewayResponse, GatewayClientError> {
    socket
        .send(Message::Text(
            request
                .encode()
                .map_err(|_| GatewayClientError::Protocol)?
                .into(),
        ))
        .await
        .map_err(|_| GatewayClientError::Transport)?;
    receive_response(socket, request.request_id()).await
}

async fn receive_response(
    socket: &mut GatewaySocket,
    request_id: &str,
) -> Result<wire::GatewayResponse, GatewayClientError> {
    loop {
        match receive_message(socket).await? {
            Message::Text(text) => match wire::decode_response(text.as_str(), request_id) {
                Ok(Some(response)) => return Ok(response),
                Ok(None) => {}
                Err(_) if wire::decode_event(text.as_str()).is_ok() => {}
                Err(_) => return Err(GatewayClientError::Protocol),
            },
            Message::Ping(payload) => send_pong(socket, payload).await?,
            Message::Pong(_) => {}
            Message::Close(_) => return Err(GatewayClientError::ConnectionClosed),
            Message::Binary(_) | Message::Frame(_) => {
                return Err(GatewayClientError::Protocol);
            }
        }
    }
}

async fn receive_message(socket: &mut GatewaySocket) -> Result<Message, GatewayClientError> {
    socket
        .next()
        .await
        .ok_or(GatewayClientError::ConnectionClosed)?
        .map_err(|_| GatewayClientError::Transport)
}

async fn send_pong(socket: &mut GatewaySocket, payload: Bytes) -> Result<(), GatewayClientError> {
    socket
        .send(Message::Pong(payload))
        .await
        .map_err(|_| GatewayClientError::Transport)
}

async fn close_quietly(socket: &mut GatewaySocket) {
    close_with_deadline(socket.close(None)).await;
}

async fn close_with_deadline(close: impl Future) {
    let _ = timeout(CLOSE_DEADLINE, close).await;
}

fn next_request_id(operation: &str) -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("matcha-{operation}-{sequence}")
}

fn next_control_instance_id() -> String {
    let sequence = NEXT_CONTROL_INSTANCE_ID.fetch_add(1, Ordering::Relaxed);
    format!("matcha-control-{sequence}")
}

struct SensitiveText {
    encoded: String,
    buffer: Bytes,
    #[cfg(test)]
    cleared_buffer: Vec<u8>,
}

impl SensitiveText {
    fn new(encoded: String) -> Self {
        let buffer = Bytes::copy_from_slice(encoded.as_bytes());
        Self {
            encoded,
            buffer,
            #[cfg(test)]
            cleared_buffer: Vec::new(),
        }
    }

    fn message(&self) -> Message {
        // SAFETY: the buffer is copied from a valid UTF-8 String.
        let text = unsafe { Utf8Bytes::from_bytes_unchecked(self.buffer.clone()) };
        Message::Text(text)
    }

    fn clear(&mut self) -> Result<(), GatewayClientError> {
        // SAFETY: replacing UTF-8 bytes with NUL bytes preserves valid UTF-8.
        unsafe { self.encoded.as_bytes_mut() }.fill(0);
        if self.buffer.is_empty() {
            return Ok(());
        }
        let buffer = std::mem::take(&mut self.buffer)
            .try_into_mut()
            .map_err(|buffer| {
                self.buffer = buffer;
                GatewayClientError::SecretCleanupFailed
            })?;
        let mut buffer = buffer;
        buffer.as_mut().fill(0);
        #[cfg(test)]
        self.cleared_buffer.extend_from_slice(&buffer);
        Ok(())
    }
}

impl Drop for SensitiveText {
    fn drop(&mut self) {
        let _ = self.clear();
    }
}

async fn send_sensitive_text(
    socket: &mut GatewaySocket,
    encoded: String,
) -> Result<(), GatewayClientError> {
    let mut sensitive = SensitiveText::new(encoded);
    let send_result = socket
        .send(sensitive.message())
        .await
        .map_err(|_| GatewayClientError::Transport);
    let clear_result = sensitive.clear();
    clear_result?;
    send_result
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Arc;

    use platform::listener_identity::{CertificateFingerprint, ListenerIdentity};
    use tokio::{net::TcpListener, net::TcpStream};
    use tokio_rustls::{
        TlsAcceptor,
        rustls::{
            ServerConfig,
            pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
        },
    };
    use tokio_tungstenite::{WebSocketStream, accept_async};

    pub(crate) type TestSocket = WebSocketStream<TcpStream>;

    pub(crate) struct TestTlsIdentity {
        fingerprint: CertificateFingerprint,
        acceptor: TlsAcceptor,
    }

    impl TestTlsIdentity {
        pub(crate) fn generate() -> Self {
            let identity = ListenerIdentity::generate_loopback().unwrap();
            let certificate = CertificateDer::from_pem_slice(identity.certificate_pem()).unwrap();
            let private_key = PrivateKeyDer::from_pem_slice(identity.private_key_pem()).unwrap();
            let provider = tokio_rustls::rustls::crypto::ring::default_provider();
            let config = ServerConfig::builder_with_provider(Arc::new(provider))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![certificate], private_key)
                .unwrap();
            Self {
                fingerprint: identity.fingerprint(),
                acceptor: TlsAcceptor::from(Arc::new(config)),
            }
        }

        pub(crate) const fn fingerprint(&self) -> CertificateFingerprint {
            self.fingerprint
        }

        pub(crate) fn acceptor(&self) -> TlsAcceptor {
            self.acceptor.clone()
        }
    }

    pub(crate) async fn accept_websocket(
        listener: &TcpListener,
        _acceptor: &TlsAcceptor,
    ) -> TestSocket {
        let (stream, _) = listener.accept().await.unwrap();
        accept_async(stream).await.unwrap()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Bytes;

    use super::{test_support::*, *};

    #[test]
    fn endpoint_builds_only_fixed_loopback_websocket_urls() {
        let ipv4 = GatewayEndpoint::try_new("127.0.0.1:18789".parse().unwrap()).unwrap();
        let ipv6 = GatewayEndpoint::try_new("[::1]:18789".parse().unwrap()).unwrap();
        assert_eq!(ipv4.websocket_url(), "ws://127.0.0.1:18789/ws");
        assert_eq!(ipv6.websocket_url(), "ws://127.0.0.1:18789/ws");
        assert_eq!(ipv4.http_url("/readyz"), "http://127.0.0.1:18789/readyz");
        assert_eq!(ipv4.address(), "127.0.0.1:18789".parse().unwrap());

        for address in ["127.0.0.1:0", "192.0.2.1:18789"] {
            let error = GatewayEndpoint::try_new(address.parse().unwrap()).unwrap_err();
            assert_eq!(error, GatewayClientError::InvalidEndpoint);
            assert_eq!(error.to_string(), "gateway endpoint is invalid");
            assert!(!error.to_string().contains(address));
        }
    }

    #[test]
    fn handshake_uses_one_absolute_budget_and_rpc_keeps_its_own_budget() {
        let started_at = Instant::now();
        let deadline = handshake_deadline(started_at);

        assert_eq!(deadline.duration_since(started_at), Duration::from_secs(15));
        assert_eq!(
            deadline.duration_since(started_at + Duration::from_secs(11)),
            Duration::from_secs(4),
        );
        assert_eq!(RPC_DEADLINE, Duration::from_secs(30));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn short_connection_cleanup_has_a_fixed_deadline() {
        let started_at = Instant::now();
        close_with_deadline(std::future::pending::<()>()).await;

        assert!(started_at.elapsed() >= CLOSE_DEADLINE);
        assert!(started_at.elapsed() < CLOSE_DEADLINE + Duration::from_secs(1));
    }

    #[test]
    fn negotiated_scopes_preserve_openclaw_operator_implication_rules() {
        assert!(grants_requested_scopes(
            &["operator.admin".to_owned()],
            wire::GATEWAY_SESSION_SCOPES
        ));
        assert!(grants_requested_scopes(
            &["operator.write".to_owned()],
            &["operator.read", "operator.write"]
        ));
        assert!(!grants_requested_scopes(
            &["operator.read".to_owned()],
            &["operator.write"]
        ));
    }

    #[test]
    fn debug_errors_and_outbound_secret_buffers_are_redacted_and_cleared() {
        let identity = TestTlsIdentity::generate();
        let secret = Arc::new(GatewaySecret::new("gateway-token-canary".into()).unwrap());
        let client = GatewayClient::new(
            GatewayEndpoint::try_new("127.0.0.1:18789".parse().unwrap()).unwrap(),
            identity.fingerprint(),
            secret,
            GatewayClientMetadata::try_new("1.0.0".into(), "windows".into()).unwrap(),
        );
        let debug = format!("{client:?}");
        assert!(!debug.contains("gateway-token-canary"));
        assert!(!debug.contains("127.0.0.1"));
        assert!(!debug.contains("18789"));
        assert!(debug.contains("[REDACTED]"));
        assert!(!format!("{:?}", GatewayControlReadiness::Unavailable).contains("canary"));

        for error in [
            GatewayClientError::Authentication,
            GatewayClientError::Transport,
            GatewayClientError::Protocol,
        ] {
            assert!(!error.to_string().contains("canary"));
            assert!(!format!("{error:?}").contains("canary"));
        }

        let mut sensitive = SensitiveText::new("token-buffer-canary".into());
        let text = sensitive.message();
        drop(text);
        sensitive.clear().unwrap();
        assert!(sensitive.encoded.as_bytes().iter().all(|byte| *byte == 0));
        assert!(!sensitive.cleared_buffer.is_empty());
        assert!(sensitive.cleared_buffer.iter().all(|byte| *byte == 0));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn plain_ws_matches_probe_golden_path() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let identity = TestTlsIdentity::generate();
        let fingerprint = identity.fingerprint();
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            serve_operation(&listener, &acceptor, wire::SYSTEM_PRESENCE_METHOD).await;
        });
        let client = GatewayClient::new(
            endpoint,
            fingerprint,
            Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
            GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
        );

        client.connect_and_probe().await.unwrap();
        client.close_control_connection().await;
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mcp_server_status_query_uses_the_control_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type": "event",
                    "event": "connect.challenge",
                    "payload": {"nonce": "fake-nonce", "ts": 42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            assert_eq!(connect["method"], "connect");
            assert_eq!(connect["params"]["scopes"], json!(CONTROL_SCOPES));
            let mut hello = hello_with_methods(
                connect["id"].as_str().unwrap(),
                &CONTROL_METHODS,
                "operator.admin",
            );
            hello["payload"]["features"]["methods"] = json!([
                wire::MCP_SERVER_STATUS_LIST_METHOD,
                wire::SYSTEM_PRESENCE_METHOD,
                "status",
                "config.get",
                "config.patch",
                "config.apply",
                "plugins.refresh",
                "agents.list",
                "skills.status",
                "channels.pairing.list",
                "sessions.describe",
            ]);
            hello["payload"]["auth"]["scopes"] = json!(CONTROL_SCOPES);
            hello["payload"]["features"]["events"] = json!(CONTROL_EVENTS);
            send_json(&mut socket, hello).await;

            let request = read_json(&mut socket).await;
            assert_eq!(request["method"], wire::MCP_SERVER_STATUS_LIST_METHOD);
            assert_eq!(
                request["params"],
                json!({
                    "sessionKey": "agent:main:session-1",
                    "limit": 100,
                    "detail": "toolsAndAuthOnly"
                })
            );
            send_json(
                &mut socket,
                json!({
                    "type": "res",
                    "id": request["id"],
                    "ok": true,
                    "payload": {
                        "data": [{
                            "name": "remote",
                            "serverName": "remote",
                            "launchSummary": "ready",
                            "toolCount": 3,
                            "available": true
                        }]
                    }
                }),
            )
            .await;
        });

        let status = client
            .observe_mcp_server_status("agent:main:session-1".into())
            .await
            .unwrap();
        assert_eq!(status.servers.len(), 1);
        assert_eq!(status.servers[0].tool_count, Some(3));
        assert_eq!(status.servers[0].available, Some(true));
        client.close_control_connection().await;
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn control_observation_is_ready_for_the_fixed_contract() {
        assert_eq!(
            observe_control_from_fake_peer(CONTROL_METHODS.to_vec()).await,
            GatewayControlReadiness::Ready,
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn control_observation_accepts_empty_presence_after_contract_hello() {
        assert_eq!(
            observe_control_from_fake_peer_with_snapshot(
                CONTROL_METHODS.to_vec(),
                json!({
                    "presence": [],
                    "health": {"ok": true},
                    "stateVersion": {"presence": 0, "health": 1},
                    "uptimeMs": 100
                }),
            )
            .await,
            GatewayControlReadiness::Ready,
        );
    }

    #[test]
    fn control_retry_delays_keep_transient_failures_short_and_starting_bounded() {
        let mut transient = GatewayControlAttempt::transient();
        let mut transient_delays = Vec::new();
        while let Some(delay) = transient.transient_retry_delay() {
            transient_delays.push(delay);
            transient = transient.next();
        }

        let mut starting = GatewayControlAttempt::starting();
        let mut starting_delays = Vec::new();
        while let Some(delay) = starting.starting_retry_delay() {
            starting_delays.push(delay);
            starting = starting.next();
        }

        assert_eq!(transient_delays, CONTROL_TRANSIENT_RETRY_DELAYS);
        assert_eq!(transient.transient_retry_delay(), None);
        assert_eq!(starting_delays, CONTROL_STARTING_RETRY_DELAYS);
        assert_eq!(starting.starting_retry_delay(), None);
    }

    #[test]
    fn control_sequence_gap_is_explicit_terminal_protocol_state() {
        let mut last_sequence = None;
        assert_eq!(
            advance_control_sequence(&mut last_sequence, Some(1)),
            GatewayControlSequenceAdvance::Accepted,
        );
        assert_eq!(last_sequence, Some(1));
        assert_eq!(
            advance_control_sequence(&mut last_sequence, Some(3)),
            GatewayControlSequenceAdvance::Gap,
        );
        assert_eq!(last_sequence, Some(1));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn control_startup_retry_reconnects_with_backoff_before_ready() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            serve_connect_failure(&listener, &acceptor).await;
            serve_control_ready_without_presence_rpc(&listener, &acceptor).await;
        });

        let started_at = Instant::now();
        assert_eq!(
            client.observe_control().await,
            GatewayControlReadiness::Ready
        );
        assert!(started_at.elapsed() >= CONTROL_STARTING_RETRY_DELAYS[0]);
        assert_eq!(
            client.control_state_view().await.phase,
            GatewayControlPhase::Ready
        );
        client.close_control_connection().await;
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn control_readiness_uses_hello_system_presence_without_presence_rpc() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            serve_control_ready_without_presence_rpc(&listener, &acceptor).await;
        });

        assert_eq!(
            client.observe_control().await,
            GatewayControlReadiness::Ready
        );
        assert_eq!(
            client.observe_control().await,
            GatewayControlReadiness::Ready
        );
        client.close_control_connection().await;
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn control_readiness_signals_once_on_first_ready() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let mut readiness = client.control_readiness();
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            serve_control_ready_without_presence_rpc(&listener, &acceptor).await;
        });

        assert_eq!(
            client.observe_control().await,
            GatewayControlReadiness::Ready
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), readiness.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(*readiness.borrow_and_update(), 1);

        assert_eq!(
            client.observe_control().await,
            GatewayControlReadiness::Ready
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), readiness.changed())
                .await
                .is_err()
        );

        client.close_control_connection().await;
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn control_close_moves_to_redacted_terminal_state() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            serve_control_ready_without_presence_rpc(&listener, &acceptor).await;
        });

        assert_eq!(
            client.observe_control().await,
            GatewayControlReadiness::Ready
        );
        let instance_id = client.control_state_view().await.instance_id;
        client.close_control_connection().await;
        let view = client.control_state_view().await;
        assert_eq!(view.phase, GatewayControlPhase::Closed);
        assert_eq!(view.instance_id, instance_id);
        assert!(!format!("{view:?}").contains("fake-gateway-token"));
        assert!(!format!("{client:?}").contains(&view.instance_id));
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn control_observation_is_starting_for_a_retryable_startup_sidecars_connect_failure() {
        assert_eq!(
            observe_connect_starting_from_fake_peer().await,
            GatewayControlReadiness::Starting,
        );
    }

    async fn observe_connect_starting_from_fake_peer() -> GatewayControlReadiness {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type": "event",
                    "event": "connect.challenge",
                    "payload": {"nonce": "fake-nonce", "ts": 42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            let connect_id = connect["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res",
                    "id": connect_id,
                    "ok": false,
                    "error": {
                        "code": "UNAVAILABLE",
                        "message": "starting",
                        "details": {"reason": "startup-sidecars"},
                        "retryable": true,
                        "retryAfterMs": 500
                    }
                }),
            )
            .await;
            assert!(matches!(
                socket.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
        });

        let readiness = client.control_readiness_snapshot().await;
        server.await.unwrap();
        readiness
    }

    async fn observe_control_from_fake_peer(methods: Vec<&'static str>) -> GatewayControlReadiness {
        observe_control_from_fake_peer_with_snapshot(
            methods,
            json!({
                "presence": [{"ts": 41}],
                "health": {"ok": true},
                "stateVersion": {"presence": 1, "health": 1},
                "uptimeMs": 100
            }),
        )
        .await
    }

    async fn observe_control_from_fake_peer_with_snapshot(
        methods: Vec<&'static str>,
        snapshot: Value,
    ) -> GatewayControlReadiness {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type": "event",
                    "event": "connect.challenge",
                    "payload": {"nonce": "fake-nonce", "ts": 42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            let connect_id = connect["id"].as_str().unwrap();
            let mut hello = hello_with_methods(connect_id, &methods, "operator.admin");
            hello["payload"]["auth"]["scopes"] = json!(CONTROL_SCOPES);
            hello["payload"]["snapshot"] = snapshot;
            send_json(&mut socket, hello).await;
        });

        let readiness = client.observe_control().await;
        server.await.unwrap();
        readiness
    }

    async fn serve_connect_failure(listener: &TcpListener, acceptor: &tokio_rustls::TlsAcceptor) {
        let mut socket = accept_websocket(listener, acceptor).await;
        send_json(
            &mut socket,
            json!({
                "type": "event",
                "event": "connect.challenge",
                "payload": {"nonce": "fake-nonce", "ts": 42}
            }),
        )
        .await;
        let connect = read_json(&mut socket).await;
        assert_eq!(connect["method"], "connect");
        send_json(
            &mut socket,
            json!({
                "type": "res",
                "id": connect["id"],
                "ok": false,
                "error": {
                    "code": "UNAVAILABLE",
                    "message": "starting",
                    "details": {"reason": "startup-sidecars"},
                    "retryable": true
                }
            }),
        )
        .await;
        assert!(matches!(
            socket.next().await.unwrap().unwrap(),
            Message::Close(_)
        ));
    }

    async fn serve_control_ready_without_presence_rpc(
        listener: &TcpListener,
        acceptor: &tokio_rustls::TlsAcceptor,
    ) {
        let mut socket = accept_websocket(listener, acceptor).await;
        send_json(
            &mut socket,
            json!({
                "type": "event",
                "event": "connect.challenge",
                "payload": {"nonce": "fake-nonce", "ts": 42}
            }),
        )
        .await;
        let connect = read_json(&mut socket).await;
        assert_eq!(connect["method"], "connect");
        assert_eq!(connect["params"]["scopes"], json!(CONTROL_SCOPES));
        assert_eq!(connect["params"]["client"]["id"], "gateway-client");
        assert_eq!(connect["params"]["client"]["mode"], "backend");
        let mut hello = hello_with_methods(
            connect["id"].as_str().unwrap(),
            &CONTROL_METHODS,
            "operator.admin",
        );
        hello["payload"]["auth"]["scopes"] = json!(CONTROL_SCOPES);
        hello["payload"]["features"]["events"] = json!(CONTROL_EVENTS);
        send_json(&mut socket, hello).await;
        let _ = socket.next().await;
    }

    fn test_client(
        listener: &TcpListener,
        certificate_fingerprint: CertificateFingerprint,
    ) -> GatewayClient {
        GatewayClient::new(
            GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
            certificate_fingerprint,
            Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
            GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
        )
    }

    async fn serve_operation(
        listener: &TcpListener,
        acceptor: &tokio_rustls::TlsAcceptor,
        method: &str,
    ) {
        let mut socket = accept_websocket(listener, acceptor).await;
        socket
            .send(Message::Text(
                json!({
                    "type": "event",
                    "event": "connect.challenge",
                    "payload": {"nonce": "fake-nonce", "ts": 42}
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let connect = read_json(&mut socket).await;
        assert_eq!(connect["method"], "connect");
        assert_eq!(connect["params"]["minProtocol"], 4);
        assert_eq!(connect["params"]["maxProtocol"], 4);
        assert_eq!(connect["params"]["client"]["id"], "gateway-client");
        assert_eq!(connect["params"]["client"]["mode"], "backend");
        assert_eq!(connect["params"]["auth"]["token"], "fake-gateway-token");
        let connect_id = connect["id"].as_str().unwrap();
        send_json(&mut socket, hello(connect_id, method)).await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], method);
        let request_id = request["id"].as_str().unwrap();
        socket
            .send(Message::Ping(Bytes::from_static(b"ping")))
            .await
            .unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": "unrelated", "ok": true, "payload": {}}),
        )
        .await;
        let payload = if method == wire::SYSTEM_PRESENCE_METHOD {
            json!([{"ts": 43}])
        } else {
            json!({"status": "scheduled"})
        };
        send_json(
            &mut socket,
            json!({"type": "res", "id": request_id, "ok": true, "payload": payload}),
        )
        .await;

        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::Pong(Bytes::from_static(b"ping"))
        );
        assert!(matches!(
            socket.next().await.unwrap().unwrap(),
            Message::Close(_)
        ));
    }

    async fn read_json(socket: &mut TestSocket) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected text frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn send_json(socket: &mut TestSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    fn hello(id: &str, method: &str) -> Value {
        hello_with_methods(id, &[method], wire::SYSTEM_PRESENCE_SCOPE)
    }

    fn hello_with_methods(id: &str, methods: &[&str], scope: &str) -> Value {
        json!({
            "type": "res", "id": id, "ok": true,
            "payload": {
                "type": "hello-ok", "protocol": 4,
                "server": {"version": "2026.9.3", "connId": "fake-connection"},
                "features": {"methods": methods, "events": ["tick"], "capabilities": CONTROL_CAPS},
                "snapshot": {
                    "presence": [{"ts": 41}], "health": {"ok": true},
                    "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 100
                },
                "auth": {"role": "operator", "scopes": [scope]},
                "policy": {
                    "maxPayload": 26214400,
                    "maxBufferedBytes": 52428800,
                    "tickIntervalMs": 15000
                }
            }
        })
    }
}
