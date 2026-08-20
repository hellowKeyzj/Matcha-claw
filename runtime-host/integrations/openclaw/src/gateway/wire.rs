use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod agents;
pub(crate) mod channel;
pub(crate) mod cron;
pub(crate) mod team;

pub use cron::{
    CronDeliveryView, CronJob, CronJobCreate, CronJobPatch, CronJobState, CronJobUpdate, CronJobs,
    CronRemoved, CronRunHistoryEntry, CronRunHistoryPage, CronRunLog, CronRunLogEntry,
    CronRunReceipt, CronRunStatus, CronSchedule, CronScheduleView, CronSessionTarget, CronWakeMode,
    add_request, decode_add, decode_list, decode_remove, decode_run, decode_runs, decode_runs_page,
    decode_update, list_request, remove_request, run_force_request, runs_page_request,
    runs_request, update_request,
};

pub const PROTOCOL_VERSION: u32 = 4;
pub const MAX_LOG_LIMIT: usize = 5_000;
pub const MAX_LOG_BYTES: usize = 1_000_000;
const MAX_LOG_LINE_BYTES: usize = 16 * 1024;
const MAX_NATIVE_SESSION_KEY_BYTES: usize = 512;
const MAX_MCP_SERVER_NAME_BYTES: usize = 128;
const MAX_MCP_CURSOR_BYTES: usize = 512;
const MAX_MCP_LAUNCH_SUMMARY_BYTES: usize = 4_096;
const MAX_MCP_TOOL_COUNT: u64 = 100_000;
const MCP_SERVER_STATUS_PAGE_LIMIT: u64 = 100;
const MCP_SERVER_STATUS_DETAIL: &str = "toolsAndAuthOnly";
pub const SYSTEM_PRESENCE_METHOD: &str = "system-presence";
pub const GATEWAY_HEALTH_METHOD: &str = "health";
pub const GATEWAY_STATUS_METHOD: &str = "status";
pub const GATEWAY_LOGS_TAIL_METHOD: &str = "logs.tail";
pub const MCP_SERVER_STATUS_LIST_METHOD: &str = "mcpServerStatus/list";
pub const SYSTEM_PRESENCE_SCOPE: &str = "operator.read";
pub const GATEWAY_SESSION_SCOPES: &[&str] = &["operator.read", "operator.write", "operator.admin"];
#[cfg(test)]
pub(crate) const GATEWAY_TEAM_READ_SCOPE: &str = "operator.read";
#[cfg(test)]
pub(crate) const GATEWAY_TEAM_WRITE_SCOPE: &str = "operator.write";
#[cfg(test)]
pub(crate) const GATEWAY_CRON_READ_SCOPE: &str = "operator.read";
pub(crate) const GATEWAY_CRON_ADMIN_SCOPE: &str = "operator.admin";
#[cfg(test)]
pub(crate) const GATEWAY_SKILL_ADMIN_SCOPE: &str = "operator.admin";
#[cfg(test)]
pub(crate) const GATEWAY_SKILL_READ_SCOPE: &str = "operator.read";
pub const SESSIONS_SUBSCRIBE_METHOD: &str = "sessions.subscribe";
#[cfg(test)]
pub(crate) const GATEWAY_OPERATIONS_SCOPE: &str = "operator.write";
pub(crate) const OPENCLAW_GATEWAY_VERSION: &str = "2026.5.20";

pub struct GatewayToken(Vec<u8>);

impl GatewayToken {
    pub fn new(value: String) -> Result<Self, WireError> {
        if value.is_empty() {
            return Err(WireError::InvalidToken);
        }
        Ok(Self(value.into_bytes()))
    }

    fn as_str(&self) -> Result<&str, WireError> {
        std::str::from_utf8(&self.0).map_err(|_| WireError::EncodeRequest)
    }
}

impl Drop for GatewayToken {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ConnectChallenge {
    pub nonce: String,
    pub timestamp_ms: u64,
}

impl fmt::Debug for ConnectChallenge {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectChallenge")
            .field("nonce", &"[REDACTED]")
            .field("timestamp_ms", &self.timestamp_ms)
            .finish()
    }
}

pub struct ConnectClient {
    pub version: String,
    pub platform: String,
    pub display_name: Option<String>,
    pub device_family: Option<String>,
    pub instance_id: Option<String>,
}

impl fmt::Debug for ConnectClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectClient")
            .field("version", &"[REDACTED]")
            .field("platform", &"[REDACTED]")
            .field(
                "display_name",
                &self.display_name.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "device_family",
                &self.device_family.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "instance_id",
                &self.instance_id.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

pub struct ConnectDevice {
    pub id: String,
    pub public_key: String,
    pub signature: String,
    pub signed_at: u64,
    pub nonce: String,
}

impl fmt::Debug for ConnectDevice {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectDevice")
            .field("id", &"[REDACTED]")
            .field("public_key", &"[REDACTED]")
            .field("signature", &"[REDACTED]")
            .field("signed_at", &"[REDACTED]")
            .field("nonce", &"[REDACTED]")
            .finish()
    }
}

pub struct ConnectParams {
    pub client: ConnectClient,
    pub scopes: Vec<String>,
    pub caps: Vec<String>,
    pub device: Option<ConnectDevice>,
}

impl fmt::Debug for ConnectParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectParams")
            .field("client", &self.client)
            .field("scopes", &"[REDACTED]")
            .field("caps", &"[REDACTED]")
            .field("device", &self.device.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

pub struct ConnectRequest {
    request_id: String,
    challenge_nonce: String,
    token: GatewayToken,
    params: ConnectParams,
}

impl ConnectRequest {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn challenge_nonce(&self) -> &str {
        &self.challenge_nonce
    }

    pub fn encode(&self) -> Result<String, WireError> {
        encode_connect_request(self)
    }
}

impl fmt::Debug for ConnectRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectRequest")
            .field("request_id", &"[REDACTED]")
            .field("challenge_nonce", &"[REDACTED]")
            .field("token", &"[REDACTED]")
            .field("params", &self.params)
            .finish()
    }
}

pub fn build_connect_request(
    request_id: String,
    nonce: String,
    token: GatewayToken,
    client_version: String,
    platform: String,
    scopes: Vec<String>,
) -> Result<ConnectRequest, WireError> {
    build_backend_connect_request(
        request_id,
        nonce,
        token,
        ConnectParams {
            client: ConnectClient {
                version: client_version,
                platform,
                display_name: None,
                device_family: None,
                instance_id: None,
            },
            scopes,
            caps: Vec::new(),
            device: None,
        },
    )
}

pub fn build_backend_connect_request(
    request_id: String,
    nonce: String,
    token: GatewayToken,
    params: ConnectParams,
) -> Result<ConnectRequest, WireError> {
    if !valid_string(&request_id) || !valid_string(&nonce) || !valid_connect_params(&params) {
        return Err(WireError::InvalidConnectRequest);
    }
    Ok(ConnectRequest {
        request_id,
        challenge_nonce: nonce,
        token,
        params,
    })
}

fn encode_connect_request(request: &ConnectRequest) -> Result<String, WireError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Params<'a> {
        min_protocol: u32,
        max_protocol: u32,
        client: Client<'a>,
        role: &'static str,
        scopes: &'a [String],
        caps: &'a [String],
        auth: Auth<'a>,
        #[serde(skip_serializing_if = "Option::is_none")]
        device: Option<Device<'a>>,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Client<'a> {
        id: &'static str,
        version: &'a str,
        platform: &'a str,
        mode: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        display_name: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        device_family: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        instance_id: Option<&'a str>,
    }
    #[derive(Serialize)]
    struct Auth<'a> {
        token: &'a str,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Device<'a> {
        id: &'a str,
        public_key: &'a str,
        signature: &'a str,
        signed_at: u64,
        nonce: &'a str,
    }
    #[derive(Serialize)]
    struct Frame<'a> {
        r#type: &'static str,
        id: &'a str,
        method: &'static str,
        params: Params<'a>,
    }

    serde_json::to_string(&Frame {
        r#type: "req",
        id: &request.request_id,
        method: "connect",
        params: Params {
            min_protocol: PROTOCOL_VERSION,
            max_protocol: PROTOCOL_VERSION,
            client: Client {
                id: "gateway-client",
                version: &request.params.client.version,
                platform: &request.params.client.platform,
                mode: "backend",
                display_name: request.params.client.display_name.as_deref(),
                device_family: request.params.client.device_family.as_deref(),
                instance_id: request.params.client.instance_id.as_deref(),
            },
            role: "operator",
            scopes: &request.params.scopes,
            caps: &request.params.caps,
            auth: Auth {
                token: request.token.as_str()?,
            },
            device: request.params.device.as_ref().map(|device| Device {
                id: &device.id,
                public_key: &device.public_key,
                signature: &device.signature,
                signed_at: device.signed_at,
                nonce: &device.nonce,
            }),
        },
    })
    .map_err(|_| WireError::EncodeRequest)
}

#[derive(Clone, Eq, PartialEq)]
pub struct RpcRequest {
    request_id: String,
    method: &'static str,
    params: Option<Value>,
}

impl RpcRequest {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn method(&self) -> &'static str {
        self.method
    }

    pub fn encode(&self) -> Result<String, WireError> {
        #[derive(Serialize)]
        struct Frame<'a> {
            r#type: &'static str,
            id: &'a str,
            method: &'static str,
            #[serde(skip_serializing_if = "Option::is_none")]
            params: Option<&'a Value>,
        }
        serde_json::to_string(&Frame {
            r#type: "req",
            id: &self.request_id,
            method: self.method,
            params: self.params.as_ref(),
        })
        .map_err(|_| WireError::EncodeRequest)
    }
}

impl fmt::Debug for RpcRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RpcRequest")
            .field("request_id", &"[REDACTED]")
            .field("method", &self.method)
            .field("params", &self.params.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

pub fn system_presence_request(request_id: String) -> Result<RpcRequest, WireError> {
    rpc_request(request_id, SYSTEM_PRESENCE_METHOD, None)
}

pub fn gateway_health_request(request_id: String, probe: bool) -> Result<RpcRequest, WireError> {
    rpc_request(
        request_id,
        GATEWAY_HEALTH_METHOD,
        probe.then(|| serde_json::json!({ "probe": true })),
    )
}

pub fn gateway_status_request(
    request_id: String,
    include_channel_summary: bool,
) -> Result<RpcRequest, WireError> {
    rpc_request(
        request_id,
        GATEWAY_STATUS_METHOD,
        (!include_channel_summary).then(|| serde_json::json!({ "includeChannelSummary": false })),
    )
}

pub fn gateway_logs_tail_request(
    request_id: String,
    cursor: Option<u64>,
    limit: usize,
    max_bytes: usize,
) -> Result<RpcRequest, WireError> {
    if !(1..=MAX_LOG_LIMIT).contains(&limit) || !(1..=MAX_LOG_BYTES).contains(&max_bytes) {
        return Err(WireError::InvalidRequest);
    }
    let mut params = serde_json::Map::new();
    if let Some(cursor) = cursor {
        params.insert("cursor".into(), serde_json::json!(cursor));
    }
    params.insert("limit".into(), serde_json::json!(limit));
    params.insert("maxBytes".into(), serde_json::json!(max_bytes));
    rpc_request(
        request_id,
        GATEWAY_LOGS_TAIL_METHOD,
        Some(Value::Object(params)),
    )
}

pub(crate) fn sessions_subscribe_request(request_id: String) -> Result<RpcRequest, WireError> {
    rpc_request(
        request_id,
        SESSIONS_SUBSCRIBE_METHOD,
        Some(Value::Object(Default::default())),
    )
}

pub(crate) fn mcp_server_status_list_request(
    request_id: String,
    session_key: String,
    cursor: Option<String>,
) -> Result<RpcRequest, WireError> {
    if !valid_native_string(&session_key, MAX_NATIVE_SESSION_KEY_BYTES)
        || cursor
            .as_deref()
            .is_some_and(|cursor| !valid_native_string(cursor, MAX_MCP_CURSOR_BYTES))
    {
        return Err(WireError::InvalidRequest);
    }
    let mut params = serde_json::Map::new();
    params.insert("sessionKey".into(), Value::String(session_key));
    if let Some(cursor) = cursor {
        params.insert("cursor".into(), Value::String(cursor));
    }
    params.insert("limit".into(), Value::from(MCP_SERVER_STATUS_PAGE_LIMIT));
    params.insert(
        "detail".into(),
        Value::String(MCP_SERVER_STATUS_DETAIL.into()),
    );
    rpc_request(
        request_id,
        MCP_SERVER_STATUS_LIST_METHOD,
        Some(Value::Object(params)),
    )
}

pub(crate) fn operations_request(
    request_id: String,
    method: &'static str,
    params: Value,
) -> Result<RpcRequest, WireError> {
    if !params.is_object() {
        return Err(WireError::InvalidRequest);
    }
    rpc_request(request_id, method, Some(params))
}

pub(crate) fn session_request(
    request_id: String,
    method: &'static str,
    params: Value,
) -> Result<RpcRequest, WireError> {
    if !params.is_object() {
        return Err(WireError::InvalidRequest);
    }
    rpc_request(request_id, method, Some(params))
}

fn rpc_request(
    request_id: String,
    method: &'static str,
    params: Option<Value>,
) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id) || !valid_string(method) {
        return Err(WireError::InvalidRequest);
    }
    Ok(RpcRequest {
        request_id,
        method,
        params,
    })
}

pub struct GatewayError {
    pub(crate) retryable: Option<bool>,
    pub(crate) startup_sidecars: bool,
    pub(crate) code: String,
    pub(crate) message: String,
    #[cfg(test)]
    pub(crate) details: Option<Value>,
    #[cfg(test)]
    pub(crate) retry_after_ms: Option<u64>,
}

impl GatewayError {
    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

pub enum GatewayResponse {
    Success {
        request_id: String,
        payload: Option<Value>,
    },
    Failure {
        request_id: String,
        error: GatewayError,
    },
}

impl GatewayResponse {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Success { request_id, .. } | Self::Failure { request_id, .. } => request_id,
        }
    }
}

pub struct GatewayEvent {
    pub name: String,
    pub payload: Option<Value>,
    pub sequence: Option<u64>,
    pub state_version: Option<StateVersion>,
}

pub fn decode_event(frame: &str) -> Result<GatewayEvent, WireError> {
    let frame: EventWire = serde_json::from_str(frame).map_err(|_| WireError::InvalidEvent)?;
    if frame.r#type != "event" || !valid_string(&frame.event) {
        return Err(WireError::InvalidEvent);
    }
    Ok(GatewayEvent {
        name: frame.event,
        payload: frame.payload,
        sequence: frame.seq,
        state_version: frame.state_version,
    })
}

pub fn decode_challenge(frame: &str) -> Result<ConnectChallenge, WireError> {
    let event = decode_event(frame).map_err(|_| WireError::InvalidChallenge)?;
    if event.name != "connect.challenge"
        || event.sequence.is_some()
        || event.state_version.is_some()
    {
        return Err(WireError::InvalidChallenge);
    }
    let payload: ChallengeWire =
        serde_json::from_value(event.payload.ok_or(WireError::InvalidChallenge)?)
            .map_err(|_| WireError::InvalidChallenge)?;
    if !valid_string(&payload.nonce) {
        return Err(WireError::InvalidChallenge);
    }
    Ok(ConnectChallenge {
        nonce: payload.nonce,
        timestamp_ms: payload.ts,
    })
}

pub fn decode_response(
    frame: &str,
    expected_request_id: &str,
) -> Result<Option<GatewayResponse>, WireError> {
    if !valid_string(expected_request_id) {
        return Err(WireError::InvalidResponse);
    }
    let frame: ResponseWire =
        serde_json::from_str(frame).map_err(|_| WireError::InvalidResponse)?;
    if frame.r#type != "res" || !valid_string(&frame.id) {
        return Err(WireError::InvalidResponse);
    }
    if frame.id != expected_request_id {
        return Ok(None);
    }
    match (frame.ok, frame.payload, frame.error) {
        (true, Field::Missing, Field::Missing) => Ok(Some(GatewayResponse::Success {
            request_id: frame.id,
            payload: None,
        })),
        (true, Field::Present(payload), Field::Missing) => Ok(Some(GatewayResponse::Success {
            request_id: frame.id,
            payload: Some(payload),
        })),
        (false, Field::Missing, Field::Present(error)) if error.is_valid() => {
            Ok(Some(GatewayResponse::Failure {
                request_id: frame.id,
                error: error.into_public(),
            }))
        }
        _ => Err(WireError::InvalidResponse),
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct HelloOk {
    pub server: GatewayServer,
    pub features: GatewayFeatures,
    pub snapshot: GatewaySnapshot,
    pub auth: GatewayAuth,
    pub policy: GatewayPolicy,
}

impl fmt::Debug for HelloOk {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HelloOk")
            .field("server", &"[REDACTED]")
            .field("features", &"[REDACTED]")
            .field("snapshot", &self.snapshot)
            .field("auth", &"[REDACTED]")
            .field("policy", &self.policy)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct GatewayServer {
    pub version: String,
    pub connection_id: String,
}

impl fmt::Debug for GatewayServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayServer")
            .field("version", &"[REDACTED]")
            .field("connection_id", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct GatewayFeatures {
    pub methods: Vec<String>,
    pub events: Vec<String>,
}

impl fmt::Debug for GatewayFeatures {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayFeatures")
            .field("methods", &"[REDACTED]")
            .field("events", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewaySnapshot {
    pub presence: Vec<PresenceEntry>,
    pub state_version: StateVersion,
    pub uptime_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StateVersion {
    pub presence: u64,
    pub health: u64,
}

#[derive(Clone, Eq, PartialEq)]
pub struct GatewayAuth {
    pub role: String,
    pub scopes: Vec<String>,
}

impl fmt::Debug for GatewayAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayAuth")
            .field("role", &"[REDACTED]")
            .field("scopes", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayPolicy {
    pub max_payload: u64,
    pub max_buffered_bytes: u64,
    pub tick_interval_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresenceEntry {
    pub timestamp_ms: u64,
}

pub fn decode_hello_ok(response: GatewayResponse) -> Result<HelloOk, WireError> {
    let payload = success_payload(response, WireError::InvalidHello)?;
    let hello: HelloWire = serde_json::from_value(payload).map_err(|_| WireError::InvalidHello)?;
    if !hello.is_valid() {
        return Err(WireError::InvalidHello);
    }
    Ok(hello.into_public())
}

pub fn decode_system_presence(response: GatewayResponse) -> Result<Vec<PresenceEntry>, WireError> {
    let payload = success_payload(response, WireError::InvalidPresence)?;
    let entries: Vec<PresenceWire> =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidPresence)?;
    if entries.iter().any(|entry| !entry.is_valid()) {
        return Err(WireError::InvalidPresence);
    }
    Ok(entries
        .into_iter()
        .map(|entry| PresenceEntry {
            timestamp_ms: entry.ts,
        })
        .collect())
}

pub fn decode_gateway_health(
    response: GatewayResponse,
) -> Result<GatewayHealthSnapshot, WireError> {
    let payload = success_payload(response, WireError::InvalidGatewayHealth)?;
    project_gateway_health(payload)
}

pub fn decode_gateway_status(
    response: GatewayResponse,
) -> Result<GatewayStatusSnapshot, WireError> {
    let payload = success_payload(response, WireError::InvalidGatewayStatus)?;
    project_gateway_status(payload)
}

pub fn decode_gateway_logs_tail(response: GatewayResponse) -> Result<GatewayLogsTail, WireError> {
    let payload = success_payload(response, WireError::InvalidGatewayLogsTail)?;
    let payload: GatewayLogsTailWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidGatewayLogsTail)?;
    payload.into_public()
}

pub fn decode_mcp_server_status_list(
    response: GatewayResponse,
) -> Result<McpServerStatusList, WireError> {
    let payload = success_payload(response, WireError::InvalidMcpServerStatus)?;
    let payload: McpServerStatusListWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidMcpServerStatus)?;
    payload.into_public()
}

#[derive(Clone, Eq, PartialEq)]
pub struct McpServerStatusList {
    pub servers: Vec<McpServerStatusEntry>,
    pub next_cursor: Option<String>,
}

impl fmt::Debug for McpServerStatusList {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpServerStatusList")
            .field("server_count", &self.servers.len())
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct McpServerStatusEntry {
    pub name: String,
    pub launch_summary: Option<String>,
    pub tool_count: Option<u64>,
    pub available: Option<bool>,
}

impl fmt::Debug for McpServerStatusEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpServerStatusEntry")
            .field("name", &"[REDACTED]")
            .field("has_launch_summary", &self.launch_summary.is_some())
            .field("tool_count", &self.tool_count)
            .field("available", &self.available)
            .finish()
    }
}

fn project_gateway_health(payload: Value) -> Result<GatewayHealthSnapshot, WireError> {
    let object = payload.as_object().ok_or(WireError::InvalidGatewayHealth)?;
    let ok = object
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or(WireError::InvalidGatewayHealth)?;
    let timestamp_ms = object
        .get("ts")
        .and_then(Value::as_u64)
        .ok_or(WireError::InvalidGatewayHealth)?;
    let duration_ms = object
        .get("durationMs")
        .and_then(Value::as_u64)
        .ok_or(WireError::InvalidGatewayHealth)?;
    let channel_count = object
        .get("channels")
        .and_then(Value::as_object)
        .map_or(0, serde_json::Map::len);
    let agent_count = object
        .get("agents")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let session_count = object
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get("count"))
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or(WireError::InvalidGatewayHealth)?;
    Ok(GatewayHealthSnapshot {
        ok,
        timestamp_ms,
        duration_ms,
        channel_count,
        agent_count,
        session_count,
    })
}

fn project_gateway_status(payload: Value) -> Result<GatewayStatusSnapshot, WireError> {
    let object = payload.as_object().ok_or(WireError::InvalidGatewayStatus)?;
    let session_count = object
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get("count"))
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or(WireError::InvalidGatewayStatus)?;
    let channel_count = object
        .get("channelSummary")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let heartbeat_enabled = object
        .get("heartbeat")
        .and_then(Value::as_object)
        .and_then(|heartbeat| heartbeat.get("agents"))
        .and_then(Value::as_array)
        .is_some_and(|agents| {
            agents.iter().any(|agent| {
                agent
                    .as_object()
                    .and_then(|agent| agent.get("enabled"))
                    .and_then(Value::as_bool)
                    == Some(true)
            })
        });
    Ok(GatewayStatusSnapshot {
        session_count,
        channel_count,
        heartbeat_enabled,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayHealthSnapshot {
    pub ok: bool,
    pub timestamp_ms: u64,
    pub duration_ms: u64,
    pub channel_count: usize,
    pub agent_count: usize,
    pub session_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayStatusSnapshot {
    pub session_count: usize,
    pub channel_count: usize,
    pub heartbeat_enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayLogsTail {
    pub file: String,
    pub cursor: u64,
    pub size: u64,
    pub lines: Vec<String>,
    pub truncated: bool,
    pub reset: bool,
}

pub(crate) fn decode_sessions_subscribe(response: GatewayResponse) -> Result<(), WireError> {
    let payload = success_payload(response, WireError::InvalidSessionSubscription)?;
    let payload: SessionSubscriptionWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidSessionSubscription)?;
    if !payload.subscribed {
        return Err(WireError::InvalidSessionSubscription);
    }
    Ok(())
}

fn success_payload(response: GatewayResponse, error: WireError) -> Result<Value, WireError> {
    match response {
        GatewayResponse::Success {
            payload: Some(payload),
            ..
        } => Ok(payload),
        _ => Err(error),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WireError {
    InvalidToken,
    InvalidConnectRequest,
    InvalidRequest,
    EncodeRequest,
    InvalidEvent,
    InvalidChallenge,
    InvalidResponse,
    InvalidHello,
    InvalidPresence,
    InvalidGatewayHealth,
    InvalidGatewayStatus,
    InvalidGatewayLogsTail,
    InvalidMcpServerStatus,
    InvalidSessionSubscription,
    InvalidAgentsListRequest,
    InvalidAgentsCreateRequest,
    InvalidAgentsUpdateRequest,
    InvalidAgentsDeleteRequest,
    InvalidAgentsFilesListRequest,
    InvalidAgentsFilesGetRequest,
    InvalidAgentsFilesSetRequest,
    InvalidAgentsWaitRequest,
    InvalidAgentsFileName,
    InvalidChannelCatalog,
    InvalidChannelConfigPatch,
    InvalidChannelConfigSchema,
    InvalidChannelRuntime,
    InvalidLoginProgress,
    InvalidConfigGetRequest,
    InvalidConfigSetRequest,
    InvalidConfigPatchRequest,
    InvalidConfigApplyRequest,
    InvalidCronListRequest,
    InvalidCronAddRequest,
    InvalidCronUpdateRequest,
    InvalidCronRemoveRequest,
    InvalidCronRunRequest,
    InvalidCronRunsRequest,
    InvalidAgentsList,
    InvalidAgentsCreate,
    InvalidAgentsUpdate,
    InvalidAgentsDelete,
    InvalidAgentsFilesList,
    InvalidAgentsFilesGet,
    InvalidAgentsFilesSet,
    InvalidAgentsWait,
    InvalidConfigGet,
    InvalidConfigSet,
    InvalidConfigPatch,
    InvalidConfigApply,
    InvalidCronList,
    InvalidCronAdd,
    InvalidCronUpdate,
    InvalidCronRemove,
    InvalidCronRun,
    InvalidCronRuns,
}

impl fmt::Display for WireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidToken => "gateway token is invalid",
            Self::InvalidConnectRequest => "connect request is invalid",
            Self::InvalidRequest => "gateway request is invalid",
            Self::EncodeRequest => "gateway request encoding failed",
            Self::InvalidEvent => "gateway event frame is invalid",
            Self::InvalidChallenge => "connect challenge frame is invalid",
            Self::InvalidResponse => "gateway response frame is invalid",
            Self::InvalidHello => "hello response is invalid",
            Self::InvalidPresence => "system presence response is invalid",
            Self::InvalidGatewayHealth => "gateway health response is invalid",
            Self::InvalidGatewayStatus => "gateway status response is invalid",
            Self::InvalidGatewayLogsTail => "gateway logs tail response is invalid",
            Self::InvalidMcpServerStatus => "MCP server status response is invalid",
            Self::InvalidSessionSubscription => "session subscription response is invalid",
            Self::InvalidAgentsListRequest => "agents list request is invalid",
            Self::InvalidAgentsCreateRequest => "agents create request is invalid",
            Self::InvalidAgentsUpdateRequest => "agents update request is invalid",
            Self::InvalidAgentsDeleteRequest => "agents delete request is invalid",
            Self::InvalidAgentsFilesListRequest => "agents files list request is invalid",
            Self::InvalidAgentsFilesGetRequest => "agents files get request is invalid",
            Self::InvalidAgentsFilesSetRequest => "agents files set request is invalid",
            Self::InvalidAgentsWaitRequest => "agents wait request is invalid",
            Self::InvalidAgentsFileName => "agents file name is invalid",
            Self::InvalidChannelCatalog => "channel catalog response is invalid",
            Self::InvalidChannelConfigPatch => "channel configuration patch is invalid",
            Self::InvalidChannelConfigSchema => "channel configuration schema is invalid",
            Self::InvalidChannelRuntime => "channel runtime response is invalid",
            Self::InvalidLoginProgress => "web login response is invalid",
            Self::InvalidConfigGetRequest => "config get request is invalid",
            Self::InvalidConfigSetRequest => "config set request is invalid",
            Self::InvalidConfigPatchRequest => "config patch request is invalid",
            Self::InvalidConfigApplyRequest => "config apply request is invalid",
            Self::InvalidCronListRequest => "cron list request is invalid",
            Self::InvalidCronAddRequest => "cron add request is invalid",
            Self::InvalidCronUpdateRequest => "cron update request is invalid",
            Self::InvalidCronRemoveRequest => "cron remove request is invalid",
            Self::InvalidCronRunRequest => "cron run request is invalid",
            Self::InvalidCronRunsRequest => "cron runs request is invalid",
            Self::InvalidAgentsList => "agents list response is invalid",
            Self::InvalidAgentsCreate => "agents create response is invalid",
            Self::InvalidAgentsUpdate => "agents update response is invalid",
            Self::InvalidAgentsDelete => "agents delete response is invalid",
            Self::InvalidAgentsFilesList => "agents files list response is invalid",
            Self::InvalidAgentsFilesGet => "agents files get response is invalid",
            Self::InvalidAgentsFilesSet => "agents files set response is invalid",
            Self::InvalidAgentsWait => "agents wait response is invalid",
            Self::InvalidConfigGet => "config get response is invalid",
            Self::InvalidConfigSet => "config set response is invalid",
            Self::InvalidConfigPatch => "config patch response is invalid",
            Self::InvalidConfigApply => "config apply response is invalid",
            Self::InvalidCronList => "cron list response is invalid",
            Self::InvalidCronAdd => "cron add response is invalid",
            Self::InvalidCronUpdate => "cron update response is invalid",
            Self::InvalidCronRemove => "cron remove response is invalid",
            Self::InvalidCronRun => "cron run response is invalid",
            Self::InvalidCronRuns => "cron runs response is invalid",
        })
    }
}

impl std::error::Error for WireError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeWire {
    nonce: String,
    ts: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EventWire {
    r#type: String,
    event: String,
    payload: Option<Value>,
    seq: Option<u64>,
    state_version: Option<StateVersion>,
}

#[derive(Default)]
enum Field<T> {
    #[default]
    Missing,
    Present(T),
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Field<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Self::Present)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseWire {
    r#type: String,
    id: String,
    ok: bool,
    #[serde(default)]
    payload: Field<Value>,
    #[serde(default)]
    error: Field<ErrorWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ErrorWire {
    code: String,
    message: String,
    details: Option<Value>,
    retryable: Option<bool>,
    retry_after_ms: Option<u64>,
}

impl ErrorWire {
    fn is_valid(&self) -> bool {
        valid_string(&self.code) && valid_string(&self.message)
    }

    fn into_public(self) -> GatewayError {
        let Self {
            code,
            message,
            details,
            retryable,
            retry_after_ms,
        } = self;
        let startup_sidecars = code == "UNAVAILABLE"
            && retryable == Some(true)
            && details
                .as_ref()
                .and_then(|details| details.get("reason"))
                .and_then(Value::as_str)
                == Some("startup-sidecars");
        #[cfg(not(test))]
        let _ = (details, retry_after_ms);
        GatewayError {
            retryable,
            startup_sidecars,
            code,
            message,
            #[cfg(test)]
            details,
            #[cfg(test)]
            retry_after_ms,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HelloWire {
    r#type: String,
    protocol: u32,
    server: ServerWire,
    features: FeaturesWire,
    snapshot: SnapshotWire,
    plugin_surface_urls: Option<BTreeMap<String, String>>,
    auth: AuthWire,
    policy: PolicyWire,
}

impl HelloWire {
    fn is_valid(&self) -> bool {
        self.r#type == "hello-ok"
            && self.protocol == PROTOCOL_VERSION
            && self.server.is_valid()
            && self.features.is_valid()
            && self.snapshot.is_valid()
            && self.plugin_surface_urls.as_ref().is_none_or(|urls| {
                urls.iter()
                    .all(|(name, url)| valid_string(name) && valid_string(url))
            })
            && self.auth.is_valid()
            && self.policy.max_payload > 0
            && self.policy.max_buffered_bytes > 0
            && self.policy.tick_interval_ms > 0
    }

    fn into_public(self) -> HelloOk {
        HelloOk {
            server: GatewayServer {
                version: self.server.version,
                connection_id: self.server.conn_id,
            },
            features: GatewayFeatures {
                methods: self.features.methods,
                events: self.features.events,
            },
            snapshot: self.snapshot.into_public(),
            auth: GatewayAuth {
                role: self.auth.role,
                scopes: self.auth.scopes,
            },
            policy: GatewayPolicy {
                max_payload: self.policy.max_payload,
                max_buffered_bytes: self.policy.max_buffered_bytes,
                tick_interval_ms: self.policy.tick_interval_ms,
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ServerWire {
    version: String,
    conn_id: String,
}

impl ServerWire {
    fn is_valid(&self) -> bool {
        valid_string(&self.version) && valid_string(&self.conn_id)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeaturesWire {
    methods: Vec<String>,
    events: Vec<String>,
}

impl FeaturesWire {
    fn is_valid(&self) -> bool {
        valid_strings(&self.methods) && valid_strings(&self.events)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SnapshotWire {
    presence: Vec<PresenceWire>,
    health: Value,
    state_version: StateVersion,
    uptime_ms: u64,
    config_path: Option<String>,
    state_dir: Option<String>,
    session_defaults: Option<SessionDefaultsWire>,
    auth_mode: Option<AuthModeWire>,
    update_available: Option<UpdateAvailableWire>,
}

impl SnapshotWire {
    fn is_valid(&self) -> bool {
        let _ = (
            &self.health,
            &self.config_path,
            &self.state_dir,
            &self.session_defaults,
            &self.auth_mode,
            &self.update_available,
        );
        self.presence.iter().all(PresenceWire::is_valid)
            && self.config_path.as_deref().is_none_or(valid_string)
            && self.state_dir.as_deref().is_none_or(valid_string)
            && self
                .session_defaults
                .as_ref()
                .is_none_or(SessionDefaultsWire::is_valid)
            && self
                .update_available
                .as_ref()
                .is_none_or(UpdateAvailableWire::is_valid)
    }

    fn into_public(self) -> GatewaySnapshot {
        GatewaySnapshot {
            presence: self
                .presence
                .into_iter()
                .map(|entry| PresenceEntry {
                    timestamp_ms: entry.ts,
                })
                .collect(),
            state_version: self.state_version,
            uptime_ms: self.uptime_ms,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SessionDefaultsWire {
    default_agent_id: String,
    main_key: String,
    main_session_key: String,
    scope: Option<String>,
}

impl SessionDefaultsWire {
    fn is_valid(&self) -> bool {
        valid_string(&self.default_agent_id)
            && valid_string(&self.main_key)
            && valid_string(&self.main_session_key)
            && self.scope.as_deref().is_none_or(valid_string)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum AuthModeWire {
    None,
    Token,
    Password,
    TrustedProxy,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateAvailableWire {
    current_version: String,
    latest_version: String,
    channel: String,
}

impl UpdateAvailableWire {
    fn is_valid(&self) -> bool {
        valid_string(&self.current_version)
            && valid_string(&self.latest_version)
            && valid_string(&self.channel)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PresenceWire {
    host: Option<String>,
    ip: Option<String>,
    version: Option<String>,
    platform: Option<String>,
    device_family: Option<String>,
    model_identifier: Option<String>,
    mode: Option<String>,
    last_input_seconds: Option<u64>,
    reason: Option<String>,
    tags: Option<Vec<String>>,
    text: Option<String>,
    ts: u64,
    device_id: Option<String>,
    roles: Option<Vec<String>>,
    scopes: Option<Vec<String>>,
    instance_id: Option<String>,
}

impl PresenceWire {
    fn is_valid(&self) -> bool {
        let _ = (&self.last_input_seconds, &self.text);
        [
            &self.host,
            &self.ip,
            &self.version,
            &self.platform,
            &self.device_family,
            &self.model_identifier,
            &self.mode,
            &self.reason,
            &self.device_id,
            &self.instance_id,
        ]
        .into_iter()
        .all(valid_optional_string)
            && [&self.tags, &self.roles, &self.scopes]
                .into_iter()
                .all(|values| values.as_ref().is_none_or(|values| valid_strings(values)))
    }
}

#[derive(Deserialize)]
#[serde(transparent)]
struct SecretWire(String);

impl Drop for SecretWire {
    fn drop(&mut self) {
        unsafe { self.0.as_bytes_mut() }.fill(0);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeviceTokenWire {
    device_token: SecretWire,
    role: String,
    scopes: Vec<String>,
    issued_at_ms: u64,
}

impl DeviceTokenWire {
    fn is_valid(&self) -> bool {
        let _ = self.issued_at_ms;
        valid_string(&self.device_token.0)
            && valid_string(&self.role)
            && valid_strings(&self.scopes)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuthWire {
    device_token: Option<SecretWire>,
    role: String,
    scopes: Vec<String>,
    issued_at_ms: Option<u64>,
    device_tokens: Option<Vec<DeviceTokenWire>>,
}

impl AuthWire {
    fn is_valid(&self) -> bool {
        let _ = self.issued_at_ms;
        self.device_token
            .as_ref()
            .is_none_or(|token| valid_string(&token.0))
            && valid_string(&self.role)
            && valid_strings(&self.scopes)
            && self
                .device_tokens
                .as_ref()
                .is_none_or(|tokens| tokens.iter().all(DeviceTokenWire::is_valid))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PolicyWire {
    max_payload: u64,
    max_buffered_bytes: u64,
    tick_interval_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayLogsTailWire {
    file: String,
    cursor: u64,
    size: u64,
    lines: Vec<String>,
    truncated: Option<bool>,
    reset: Option<bool>,
}

impl GatewayLogsTailWire {
    fn into_public(self) -> Result<GatewayLogsTail, WireError> {
        if !valid_string(&self.file)
            || self.lines.iter().any(|line| {
                line.is_empty() || line.len() > MAX_LOG_LINE_BYTES || line.contains(['\r', '\0'])
            })
        {
            return Err(WireError::InvalidGatewayLogsTail);
        }
        Ok(GatewayLogsTail {
            file: "[REDACTED]".into(),
            cursor: self.cursor,
            size: self.size,
            lines: self.lines,
            truncated: self.truncated.unwrap_or(false),
            reset: self.reset.unwrap_or(false),
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct McpServerStatusListWire {
    data: Vec<McpServerStatusEntryWire>,
    next_cursor: Option<String>,
}

impl McpServerStatusListWire {
    fn into_public(self) -> Result<McpServerStatusList, WireError> {
        if self
            .next_cursor
            .as_deref()
            .is_some_and(|cursor| !valid_native_string(cursor, MAX_MCP_CURSOR_BYTES))
        {
            return Err(WireError::InvalidMcpServerStatus);
        }
        let servers = self
            .data
            .into_iter()
            .map(McpServerStatusEntryWire::into_public)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(McpServerStatusList {
            servers,
            next_cursor: self.next_cursor,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct McpServerStatusEntryWire {
    name: String,
    server_name: String,
    launch_summary: Option<String>,
    tool_count: Option<u64>,
    available: Option<bool>,
}

impl McpServerStatusEntryWire {
    fn into_public(self) -> Result<McpServerStatusEntry, WireError> {
        if self.name != self.server_name
            || !valid_native_string(&self.name, MAX_MCP_SERVER_NAME_BYTES)
            || self
                .launch_summary
                .as_deref()
                .is_some_and(|value| !valid_native_string(value, MAX_MCP_LAUNCH_SUMMARY_BYTES))
            || self
                .tool_count
                .is_some_and(|count| count > MAX_MCP_TOOL_COUNT)
        {
            return Err(WireError::InvalidMcpServerStatus);
        }
        Ok(McpServerStatusEntry {
            name: self.name,
            launch_summary: self.launch_summary,
            tool_count: self.tool_count,
            available: self.available,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionSubscriptionWire {
    subscribed: bool,
}

fn valid_string(value: &str) -> bool {
    !value.is_empty()
}

fn valid_native_string(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= max_bytes
        && !value.chars().any(char::is_control)
}

fn valid_optional_string(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(valid_string)
}

fn valid_connect_params(params: &ConnectParams) -> bool {
    valid_string(&params.client.version)
        && valid_string(&params.client.platform)
        && [
            &params.client.display_name,
            &params.client.device_family,
            &params.client.instance_id,
        ]
        .into_iter()
        .all(valid_optional_string)
        && valid_strings(&params.scopes)
        && valid_strings(&params.caps)
        && params.device.as_ref().is_none_or(|device| {
            valid_string(&device.id)
                && valid_string(&device.public_key)
                && valid_string(&device.signature)
                && device.signed_at > 0
                && valid_string(&device.nonce)
        })
}

fn valid_strings(values: &[String]) -> bool {
    values.iter().all(|value| valid_string(value))
}

#[cfg(test)]
mod tests {
    use std::fmt::{Debug, Display};

    use serde::Serialize;
    use serde_json::json;

    use super::*;

    fn response(id: &str, payload: Value) -> GatewayResponse {
        decode_response(
            &json!({"type": "res", "id": id, "ok": true, "payload": payload}).to_string(),
            id,
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn challenge_connect_and_generic_event_match_v4_golden_frames() {
        let frame =
            r#"{"type":"event","event":"connect.challenge","payload":{"nonce":"nonce-1","ts":42}}"#;
        assert_eq!(decode_event(frame).unwrap().name, "connect.challenge");
        let challenge = decode_challenge(frame).unwrap();
        assert_eq!(challenge.timestamp_ms, 42);
        let request = build_backend_connect_request(
            "connect-1".into(),
            challenge.nonce,
            GatewayToken::new("test-only-token".into()).unwrap(),
            ConnectParams {
                client: ConnectClient {
                    version: "1.2.3".into(),
                    platform: "windows".into(),
                    display_name: Some("Matcha Backend".into()),
                    device_family: Some("desktop".into()),
                    instance_id: Some("instance-1".into()),
                },
                scopes: vec![SYSTEM_PRESENCE_SCOPE.into()],
                caps: vec!["sessions".into(), "gateway-control".into()],
                device: Some(ConnectDevice {
                    id: "device-1".into(),
                    public_key: "public-key-1".into(),
                    signature: "signature-1".into(),
                    signed_at: 1_774_051_200_000,
                    nonce: "device-nonce-1".into(),
                }),
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "connect-1", "method": "connect",
                "params": {
                    "minProtocol": 4, "maxProtocol": 4,
                    "client": {
                        "id": "gateway-client", "version": "1.2.3", "platform": "windows", "mode": "backend",
                        "displayName": "Matcha Backend", "deviceFamily": "desktop", "instanceId": "instance-1"
                    },
                    "role": "operator", "scopes": ["operator.read"], "caps": ["sessions", "gateway-control"],
                    "auth": {"token": "test-only-token"},
                    "device": {
                        "id": "device-1",
                        "publicKey": "public-key-1",
                        "signature": "signature-1",
                        "signedAt": 1774051200000_u64,
                        "nonce": "device-nonce-1"
                    }
                }
            })
        );
        assert_eq!(request.challenge_nonce(), "nonce-1");
    }

    #[test]
    fn hello_ok_decodes_required_v4_contract() {
        let hello = decode_hello_ok(response(
            "connect-1",
            json!({
                "type": "hello-ok", "protocol": 4,
                "server": {"version": "2026.5.20", "connId": "conn-1"},
                "features": {"methods": ["system-presence"], "events": ["tick"]},
                "snapshot": {"presence": [{"ts": 40}], "health": {"ok": true}, "stateVersion": {"presence": 2, "health": 3}, "uptimeMs": 100},
                "auth": {"role": "operator", "scopes": ["operator.read"]},
                "policy": {"maxPayload": 26214400, "maxBufferedBytes": 52428800, "tickIntervalMs": 15000}
            }),
        ))
        .unwrap();
        assert_eq!(hello.server.connection_id, "conn-1");
        assert_eq!(hello.features.events, ["tick"]);
        assert_eq!(hello.auth.scopes, ["operator.read"]);
        assert_eq!(hello.snapshot.presence[0].timestamp_ms, 40);
        assert_eq!(hello.policy.tick_interval_ms, 15_000);
    }

    #[test]
    fn response_correlation_ignores_unknown_ids_and_preserves_errors() {
        assert!(
            decode_response(
                r#"{"type":"res","id":"other","ok":true,"payload":{"ok":true}}"#,
                "wanted"
            )
            .unwrap()
            .is_none()
        );
        let failure = decode_response(
            r#"{"type":"res","id":"wanted","ok":false,"error":{"code":"UNAVAILABLE","message":"starting","retryable":true,"retryAfterMs":250}}"#,
            "wanted",
        )
        .unwrap()
        .unwrap();
        let GatewayResponse::Failure { error, .. } = failure else {
            panic!("expected failure response");
        };
        assert_eq!(error.code, "UNAVAILABLE");
        assert_eq!(error.message, "starting");
        assert_eq!(error.details, None);
        assert_eq!(error.retry_after_ms, Some(250));
        assert!(!error.startup_sidecars);

        let failure = decode_response(
            r#"{"type":"res","id":"wanted","ok":false,"error":{"code":"UNAVAILABLE","message":"starting","details":{"reason":"startup-sidecars"},"retryable":true,"retryAfterMs":500}}"#,
            "wanted",
        )
        .unwrap()
        .unwrap();
        let GatewayResponse::Failure { error, .. } = failure else {
            panic!("expected failure response");
        };
        assert!(error.startup_sidecars);
    }

    #[test]
    fn mcp_server_status_request_and_response_are_strict_and_safe() {
        let request = mcp_server_status_list_request(
            "mcp-status-1".into(),
            "agent:main:session-1".into(),
            None,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request.encode().unwrap()).unwrap(),
            json!({
                "type": "req",
                "id": "mcp-status-1",
                "method": MCP_SERVER_STATUS_LIST_METHOD,
                "params": {
                    "sessionKey": "agent:main:session-1",
                    "limit": 100,
                    "detail": "toolsAndAuthOnly"
                }
            })
        );
        assert!(mcp_server_status_list_request("id".into(), " ".into(), None).is_err());
        assert!(
            mcp_server_status_list_request("id".into(), "agent:main:session-1 ".into(), None)
                .is_err()
        );

        let status = decode_mcp_server_status_list(response(
            "mcp-status-1",
            json!({
                "data": [{
                    "name": "remote",
                    "serverName": "remote",
                    "launchSummary": "ready",
                    "toolCount": 3,
                    "available": true
                }]
            }),
        ))
        .unwrap();
        assert_eq!(status.servers.len(), 1);
        assert_eq!(status.servers[0].name, "remote");
        assert_eq!(status.servers[0].tool_count, Some(3));
        assert_eq!(status.servers[0].available, Some(true));
        assert_eq!(status.next_cursor, None);
        assert!(!format!("{status:?}").contains("remote"));

        for payload in [
            json!({ "data": [], "nextCursor": " " }),
            json!({ "data": [{ "name": "remote", "serverName": "other" }] }),
            json!({ "data": [{ "name": "remote", "serverName": "remote", "future": true }] }),
            json!({ "data": [{ "name": "remote", "serverName": "remote", "toolCount": 100_001 }] }),
            json!({ "data": [{ "name": " ", "serverName": " " }] }),
        ] {
            assert_eq!(
                decode_mcp_server_status_list(response("mcp-status-1", payload)),
                Err(WireError::InvalidMcpServerStatus)
            );
        }
    }

    #[test]
    fn empty_mcp_server_status_data_is_a_successful_catalog_miss() {
        let status = decode_mcp_server_status_list(response(
            "mcp-status-1",
            json!({ "data": [], "nextCursor": "cursor-1" }),
        ))
        .unwrap();
        assert!(status.servers.is_empty());
        assert_eq!(status.next_cursor.as_deref(), Some("cursor-1"));
    }

    #[test]
    fn presence_matches_golden_frames() {
        let presence = system_presence_request("presence-1".into()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&presence.encode().unwrap()).unwrap(),
            json!({"type": "req", "id": "presence-1", "method": "system-presence"})
        );
        assert_eq!(
            decode_system_presence(response("presence-1", json!([{"ts": 41}]))).unwrap(),
            [PresenceEntry { timestamp_ms: 41 }]
        );
    }

    #[test]
    fn sessions_subscribe_wire_primitive_is_not_main_session_chain() {
        let subscribe = sessions_subscribe_request("subscribe-1".into()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&subscribe.encode().unwrap()).unwrap(),
            json!({"type": "req", "id": "subscribe-1", "method": "sessions.subscribe", "params": {}})
        );
        assert!(
            decode_sessions_subscribe(response("subscribe-1", json!({"subscribed": true}))).is_ok()
        );
        assert!(
            decode_sessions_subscribe(response("subscribe-1", json!({"subscribed": false})))
                .is_err()
        );
        assert!(
            decode_sessions_subscribe(response(
                "subscribe-1",
                json!({"subscribed": true, "future": true})
            ))
            .is_err()
        );
    }

    #[test]
    fn hello_validates_unprojected_fields_without_retaining_them() {
        let canaries = [
            "config-path-canary",
            "state-dir-canary",
            "default-agent-canary",
            "main-key-canary",
            "main-session-key-canary",
            "scope-canary",
            "device-token-canary",
        ];
        let payload = json!({
            "type": "hello-ok", "protocol": 4,
            "server": {"version": "2026.5.20", "connId": "conn-1"},
            "features": {"methods": ["system-presence"], "events": ["tick"]},
            "snapshot": {
                "presence": [{"ts": 40}], "health": {"ok": true}, "stateVersion": {"presence": 2, "health": 3}, "uptimeMs": 100,
                "configPath": "config-path-canary", "stateDir": "state-dir-canary",
                "sessionDefaults": {"defaultAgentId": "default-agent-canary", "mainKey": "main-key-canary", "mainSessionKey": "main-session-key-canary", "scope": "scope-canary"},
                "authMode": "trusted-proxy",
                "updateAvailable": {"currentVersion": "1.0.0", "latestVersion": "1.1.0", "channel": "stable"}
            },
            "auth": {"deviceToken": "device-token-canary", "role": "operator", "scopes": ["operator.read"]},
            "policy": {"maxPayload": 26214400, "maxBufferedBytes": 52428800, "tickIntervalMs": 15000}
        });
        let hello = decode_hello_ok(response("connect-1", payload.clone())).unwrap();
        assert_debug_redacts(&hello, &canaries);

        let mut unknown_session_default = payload.clone();
        unknown_session_default["snapshot"]["sessionDefaults"]["future"] = json!(true);
        let mut unknown_auth_mode = payload.clone();
        unknown_auth_mode["snapshot"]["authMode"] = json!("future");
        let mut empty_path = payload;
        empty_path["snapshot"]["configPath"] = json!("");
        for invalid in [unknown_session_default, unknown_auth_mode, empty_path] {
            let error = decode_hello_ok(response("connect-1", invalid)).unwrap_err();
            assert_eq!(error, WireError::InvalidHello);
            for canary in canaries {
                assert!(!error.to_string().contains(canary));
                assert!(!format!("{error:?}").contains(canary));
            }
        }
    }

    #[test]
    fn malformed_frames_return_fixed_errors_without_echoing_input() {
        let canary = "frame-canary-value";
        for frame in [
            format!(
                r#"{{"type":"event","event":"connect.challenge","payload":{{"nonce":"{canary}"}}}}"#
            ),
            format!(
                r#"{{"type":"event","event":"wrong","payload":{{"nonce":"{canary}","ts":1}}}}"#
            ),
            format!(
                r#"{{"type":"event","event":"connect.challenge","payload":{{"nonce":"{canary}","ts":1,"extra":true}}}}"#
            ),
        ] {
            let error = decode_challenge(&frame).unwrap_err();
            assert_eq!(error, WireError::InvalidChallenge);
            assert!(!error.to_string().contains(canary));
            assert!(!format!("{error:?}").contains(canary));
        }
        assert!(
            decode_response(
                r#"{"type":"res","id":"id","ok":true,"error":{"code":"BAD","message":"bad"}}"#,
                "id"
            )
            .is_err()
        );
        assert!(decode_hello_ok(response("id", json!({"type":"hello-ok","protocol":3}))).is_err());
        assert!(decode_system_presence(response("id", json!([{}]))).is_err());
    }

    trait AmbiguousIfClone<A> {}
    impl<T> AmbiguousIfClone<()> for T {}
    impl<T: Clone> AmbiguousIfClone<u8> for T {}
    trait AmbiguousIfDebug<A> {}
    impl<T> AmbiguousIfDebug<()> for T {}
    impl<T: Debug> AmbiguousIfDebug<u8> for T {}
    trait AmbiguousIfDisplay<A> {}
    impl<T> AmbiguousIfDisplay<()> for T {}
    impl<T: Display> AmbiguousIfDisplay<u8> for T {}
    trait AmbiguousIfSerialize<A> {}
    impl<T> AmbiguousIfSerialize<()> for T {}
    impl<T: Serialize> AmbiguousIfSerialize<u8> for T {}
    fn assert_not_clone<T: AmbiguousIfClone<A>, A>() {}
    fn assert_not_debug<T: AmbiguousIfDebug<A>, A>() {}
    fn assert_not_display<T: AmbiguousIfDisplay<A>, A>() {}
    fn assert_not_serialize<T: AmbiguousIfSerialize<A>, A>() {}

    fn assert_debug_redacts(value: &impl Debug, canaries: &[&str]) {
        let debug = format!("{value:?}");
        for canary in canaries {
            assert!(!debug.contains(canary));
        }
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn secret_and_raw_wire_types_do_not_gain_exposing_traits() {
        assert_not_clone::<GatewayToken, _>();
        assert_not_debug::<GatewayToken, _>();
        assert_not_display::<GatewayToken, _>();
        assert_not_serialize::<GatewayToken, _>();
        assert_not_debug::<GatewayError, _>();
        assert_not_debug::<GatewayResponse, _>();
        assert_not_debug::<GatewayEvent, _>();
    }

    #[test]
    fn challenge_and_request_debug_redact_peer_controlled_values() {
        let challenge = ConnectChallenge {
            nonce: "challenge-nonce-canary".into(),
            timestamp_ms: 42,
        };
        assert_debug_redacts(&challenge, &["challenge-nonce-canary"]);

        let request = build_backend_connect_request(
            "connect-request-id-canary".into(),
            "connect-nonce-canary".into(),
            GatewayToken::new("token-canary".into()).unwrap(),
            ConnectParams {
                client: ConnectClient {
                    version: "client-version-canary".into(),
                    platform: "client-platform-canary".into(),
                    display_name: Some("client-display-name-canary".into()),
                    device_family: Some("client-device-family-canary".into()),
                    instance_id: Some("client-instance-id-canary".into()),
                },
                scopes: vec!["connect-scope-canary".into()],
                caps: vec!["connect-cap-canary".into()],
                device: Some(ConnectDevice {
                    id: "device-id-canary".into(),
                    public_key: "device-public-key-canary".into(),
                    signature: "device-signature-canary".into(),
                    signed_at: 42,
                    nonce: "device-nonce-canary".into(),
                }),
            },
        )
        .unwrap();
        assert_debug_redacts(
            &request,
            &[
                "connect-request-id-canary",
                "connect-nonce-canary",
                "token-canary",
                "client-version-canary",
                "client-platform-canary",
                "client-display-name-canary",
                "client-device-family-canary",
                "client-instance-id-canary",
                "connect-scope-canary",
                "connect-cap-canary",
                "device-id-canary",
                "device-public-key-canary",
                "device-signature-canary",
                "device-signed-at-canary",
                "device-nonce-canary",
            ],
        );

        let rpc = system_presence_request("rpc-request-id-canary".into()).unwrap();
        assert_debug_redacts(&rpc, &["rpc-request-id-canary"]);
    }

    #[test]
    fn hello_debug_redacts_server_features_and_auth_at_every_wrapper() {
        let hello = decode_hello_ok(response(
            "connect-1",
            json!({
                "type": "hello-ok", "protocol": 4,
                "server": {"version": "server-version-canary", "connId": "connection-id-canary"},
                "features": {"methods": ["feature-method-canary"], "events": ["feature-event-canary"]},
                "snapshot": {"presence": [{"ts": 40}], "health": {"ok": true}, "stateVersion": {"presence": 2, "health": 3}, "uptimeMs": 100},
                "auth": {"role": "auth-role-canary", "scopes": ["auth-scope-canary"]},
                "policy": {"maxPayload": 26214400, "maxBufferedBytes": 52428800, "tickIntervalMs": 15000}
            }),
        ))
        .unwrap();
        let canaries = [
            "server-version-canary",
            "connection-id-canary",
            "feature-method-canary",
            "feature-event-canary",
            "auth-role-canary",
            "auth-scope-canary",
        ];

        assert_debug_redacts(&hello.server, &canaries[..2]);
        assert_debug_redacts(&hello.features, &canaries[2..4]);
        assert_debug_redacts(&hello.auth, &canaries[4..]);
        assert_debug_redacts(&hello, &canaries);
    }
}
