use platform::state_dir::CanonicalStateDir;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};
use zeroize::Zeroize;

use crate::{
    gateway::{
        client::GatewayClient,
        wire::{self, GatewayResponse},
    },
    native_config::config_store::OpenClawConfigStore,
};

use super::identity::{AccountId, ChannelId};
use crate::gateway::operation::{
    ReadError as OperationsReadError, next_request_id, read as read_gateway,
};

const CHANNELS_STATUS_METHOD: &str = "channels.status";
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PUBLIC_CHANNEL_STATUS_ERROR: &str = "Channel status reported an error";
/// Config determines channel presence; native account discovery and Gateway
/// status supply account identity and runtime facts. Secrets stay private.
pub struct ChannelStatusOperation {
    gateway: Arc<GatewayClient>,
    state_dir: Option<CanonicalStateDir>,
    runtime_running: bool,
}

impl ChannelStatusOperation {
    pub fn new(
        gateway: Arc<GatewayClient>,
        state_dir: Option<CanonicalStateDir>,
        runtime_running: bool,
    ) -> Self {
        Self {
            gateway,
            state_dir,
            runtime_running,
        }
    }

    pub async fn observe(&self) -> ChannelStatusEffect {
        match self.read_snapshot(true).await {
            ChannelSnapshotEffect::Observed(snapshot) => {
                let observations = snapshot
                    .channel_accounts
                    .into_iter()
                    .flat_map(|(channel, accounts)| {
                        accounts
                            .into_iter()
                            .map(move |account| ChannelAccountStatus {
                                channel: channel.clone(),
                                account_id: account.account_id,
                                connection: match account.connected {
                                    Some(true) => ChannelConnection::Connected,
                                    Some(false) => ChannelConnection::Disconnected,
                                    None => ChannelConnection::Unknown,
                                },
                            })
                    })
                    .collect();
                ChannelStatusEffect::Observed(ChannelStatusReceipt { observations })
            }
            ChannelSnapshotEffect::RuntimeRejected => ChannelStatusEffect::RuntimeRejected,
            ChannelSnapshotEffect::OutcomeUnknown => ChannelStatusEffect::OutcomeUnknown,
        }
    }

    pub async fn observe_snapshot(&self) -> ChannelSnapshotEffect {
        self.read_snapshot(false).await
    }

    async fn read_snapshot(&self, probe: bool) -> ChannelSnapshotEffect {
        let configured = match self.configured_accounts().await {
            Ok(configured) => configured,
            Err(ChannelStatusReadError::Rejected) => {
                status_trace("status.configured", "outcome=rejected");
                return ChannelSnapshotEffect::RuntimeRejected;
            }
            Err(ChannelStatusReadError::Unknown) => {
                status_trace("status.configured", "outcome=unknown");
                return ChannelSnapshotEffect::OutcomeUnknown;
            }
        };
        let (channel_count, account_count) = configured_counts(&configured);
        status_trace(
            "status.configured",
            &format!("outcome=ok channels={channel_count} accounts={account_count}"),
        );
        if configured.channels.is_empty() {
            return ChannelSnapshotEffect::Observed(empty_channel_snapshot());
        }
        if !self.runtime_running {
            return ChannelSnapshotEffect::Observed(offline_channel_snapshot(&configured));
        }
        let request =
            match channel_status_request(next_request_id("channel-status-snapshot"), None, probe) {
                Ok(request) => request,
                Err(_) => {
                    status_trace("status.gateway.channels_status", "outcome=encode_invalid");
                    return ChannelSnapshotEffect::OutcomeUnknown;
                }
            };
        let response = match read_gateway(&self.gateway, request).await {
            Ok(response) => response,
            Err(OperationsReadError::Rejected) => {
                status_trace("status.gateway.channels_status", "outcome=read_rejected");
                return ChannelSnapshotEffect::RuntimeRejected;
            }
            Err(error) => {
                status_trace(
                    "status.gateway.channels_status",
                    &format!(
                        "outcome=read_error kind={}",
                        operations_read_error_label(error)
                    ),
                );
                return ChannelSnapshotEffect::OutcomeUnknown;
            }
        };
        status_trace(
            "status.gateway.channels_status",
            &format!("outcome={}", gateway_response_label(&response)),
        );
        if matches!(response, GatewayResponse::Failure { .. }) {
            return ChannelSnapshotEffect::RuntimeRejected;
        }
        match decode_channel_snapshot(response, &configured) {
            Ok(snapshot) => ChannelSnapshotEffect::Observed(snapshot),
            Err(()) => ChannelSnapshotEffect::OutcomeUnknown,
        }
    }

    async fn configured_accounts(
        &self,
    ) -> Result<ConfiguredChannelAccounts, ChannelStatusReadError> {
        if !self.runtime_running {
            status_trace(
                "status.config_source",
                "source=store reason=runtime_stopped",
            );
            return self.configured_accounts_from_store();
        }
        match self.configured_accounts_from_gateway().await {
            Ok(configured) => {
                status_trace("status.config_source", "source=gateway outcome=ok");
                Ok(configured)
            }
            Err(ChannelStatusReadError::Rejected) => {
                status_trace("status.config_source", "source=gateway outcome=rejected");
                Err(ChannelStatusReadError::Rejected)
            }
            Err(ChannelStatusReadError::Unknown) => {
                status_trace("status.config_source", "source=gateway outcome=unknown");
                Err(ChannelStatusReadError::Unknown)
            }
        }
    }

    async fn configured_accounts_from_gateway(
        &self,
    ) -> Result<ConfiguredChannelAccounts, ChannelStatusReadError> {
        let request =
            match wire::channel::config_get_request(next_request_id("channel-status-config")) {
                Ok(request) => request,
                Err(_) => {
                    status_trace("status.gateway.config_get", "outcome=encode_invalid");
                    return Err(ChannelStatusReadError::Unknown);
                }
            };
        let response = match read_gateway(&self.gateway, request).await {
            Ok(response) => response,
            Err(error) => {
                status_trace(
                    "status.gateway.config_get",
                    &format!(
                        "outcome=read_error kind={}",
                        operations_read_error_label(error)
                    ),
                );
                return Err(ChannelStatusReadError::from(error));
            }
        };
        status_trace(
            "status.gateway.config_get",
            &format!("outcome={}", gateway_response_label(&response)),
        );
        let document = match response {
            GatewayResponse::Failure { .. } => return Err(ChannelStatusReadError::Rejected),
            response => match wire::channel::decode_config_document(response) {
                Ok(document) => document,
                Err(_) => {
                    status_trace("status.config_document", "outcome=decode_invalid");
                    return Err(ChannelStatusReadError::Unknown);
                }
            },
        };
        let mut document: Value = match serde_json::from_slice(&document) {
            Ok(document) => document,
            Err(_) => {
                status_trace("status.config_document", "outcome=json_invalid");
                return Err(ChannelStatusReadError::Unknown);
            }
        };
        let configured = configured_channel_accounts(&document);
        zeroize_value(&mut document);
        let configured = match configured {
            Ok(configured) => configured,
            Err(_) => {
                status_trace("status.config_document", "outcome=config_invalid");
                return Err(ChannelStatusReadError::Unknown);
            }
        };
        self.discover_accounts(configured)
    }

    fn configured_accounts_from_store(
        &self,
    ) -> Result<ConfiguredChannelAccounts, ChannelStatusReadError> {
        let state_dir = self
            .state_dir
            .clone()
            .ok_or(ChannelStatusReadError::Unknown)?;
        let document = OpenClawConfigStore::new(state_dir)
            .read()
            .map_err(|_| ChannelStatusReadError::Unknown)?;
        let configured = configured_channel_accounts(&document.as_value())
            .map_err(|_| ChannelStatusReadError::Unknown)?;
        self.discover_accounts(configured)
    }

    fn discover_accounts(
        &self,
        mut configured: ConfiguredChannelAccounts,
    ) -> Result<ConfiguredChannelAccounts, ChannelStatusReadError> {
        for channel in &mut configured.channels {
            if channel.channel != super::weixin_login::OPENCLAW_WEIXIN_CHANNEL {
                continue;
            }
            let Some(state_dir) = &self.state_dir else {
                continue;
            };
            let bytes = state_dir
                .read_nested_regular_file_bounded(
                    &["openclaw-weixin".into(), "accounts.json".into()],
                    1_048_576,
                )
                .map_err(|_| ChannelStatusReadError::Unknown)?;
            channel.accounts = match bytes {
                None => Vec::new(),
                Some(bytes) => serde_json::from_slice::<Vec<String>>(&bytes)
                    .map_err(|_| ChannelStatusReadError::Unknown)?,
            };
            for account in &channel.accounts {
                AccountId::try_new(account.clone()).map_err(|_| ChannelStatusReadError::Unknown)?;
            }
            channel.accounts.sort();
            channel.accounts.dedup();
            channel.default_account_id = channel.accounts.first().cloned();
        }
        Ok(configured)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelConnection {
    Connected,
    Disconnected,
    Unknown,
}

impl ChannelConnection {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::Disconnected => "disconnected",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelAccountStatus {
    channel: String,
    account_id: String,
    connection: ChannelConnection,
}

impl ChannelAccountStatus {
    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub const fn connection(&self) -> ChannelConnection {
        self.connection
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelStatusReceipt {
    observations: Vec<ChannelAccountStatus>,
}

impl ChannelStatusReceipt {
    pub fn observations(&self) -> &[ChannelAccountStatus] {
        &self.observations
    }
}

#[derive(Clone, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatusSnapshot {
    pub ts: u64,
    pub partial: bool,
    pub warnings: Vec<String>,
    pub channel_order: Vec<String>,
    pub channels: BTreeMap<String, ChannelSummarySnapshot>,
    pub channel_accounts: BTreeMap<String, Vec<ChannelAccountSnapshot>>,
    pub channel_default_account_id: BTreeMap<String, String>,
}

impl fmt::Debug for ChannelStatusSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChannelStatusSnapshot")
            .field("ts", &self.ts)
            .field("partial", &self.partial)
            .field("warnings", &self.warnings)
            .field("channel_order", &self.channel_order)
            .field("channels", &self.channels)
            .field("channel_accounts", &self.channel_accounts)
            .field(
                "channel_default_account_id",
                &self.channel_default_account_id,
            )
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSummarySnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configured: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl fmt::Debug for ChannelSummarySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChannelSummarySnapshot")
            .field("configured", &self.configured)
            .field("running", &self.running)
            .field("error", &self.error.as_ref().map(|_| "[REDACTED]"))
            .field(
                "last_error",
                &self.last_error.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAccountSnapshot {
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configured: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_inbound_at: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_outbound_at: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_probe_at: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe: Option<ChannelProbeSnapshot>,
}

impl fmt::Debug for ChannelAccountSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChannelAccountSnapshot")
            .field("account_id", &self.account_id)
            .field("configured", &self.configured)
            .field("connected", &self.connected)
            .field("running", &self.running)
            .field("linked", &self.linked)
            .field(
                "last_error",
                &self.last_error.as_ref().map(|_| "[REDACTED]"),
            )
            .field("name", &self.name)
            .field("last_connected_at", &self.last_connected_at)
            .field("last_inbound_at", &self.last_inbound_at)
            .field("last_outbound_at", &self.last_outbound_at)
            .field("last_probe_at", &self.last_probe_at)
            .field("probe", &self.probe)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelProbeSnapshot {
    pub ok: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelSnapshotEffect {
    Observed(ChannelStatusSnapshot),
    RuntimeRejected,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelStatusEffect {
    Observed(ChannelStatusReceipt),
    RuntimeRejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy)]
enum ChannelStatusReadError {
    Rejected,
    Unknown,
}

impl From<OperationsReadError> for ChannelStatusReadError {
    fn from(value: OperationsReadError) -> Self {
        match value {
            OperationsReadError::Rejected => Self::Rejected,
            OperationsReadError::Unavailable | OperationsReadError::Protocol => Self::Unknown,
        }
    }
}

fn status_trace(phase: &str, detail: &str) {
    super::config::channel_trace(phase, detail);
}

fn operations_read_error_label(error: OperationsReadError) -> &'static str {
    match error {
        OperationsReadError::Unavailable => "unavailable",
        OperationsReadError::Rejected => "rejected",
        OperationsReadError::Protocol => "protocol",
    }
}

fn gateway_response_label(response: &GatewayResponse) -> &'static str {
    match response {
        GatewayResponse::Success { payload: None, .. } => "success_payload_none",
        GatewayResponse::Success {
            payload: Some(Value::Object(_)),
            ..
        } => "success_payload_object",
        GatewayResponse::Success { .. } => "success_payload_other",
        GatewayResponse::Failure { .. } => "failure",
    }
}

fn configured_counts(configured: &ConfiguredChannelAccounts) -> (usize, usize) {
    (
        configured.channels.len(),
        configured
            .channels
            .iter()
            .map(|channel| channel.accounts.len())
            .sum(),
    )
}

fn channel_status_request(
    request_id: String,
    channel: Option<&ChannelId>,
    probe: bool,
) -> Result<wire::RpcRequest, wire::WireError> {
    let params = match channel {
        Some(channel) => json!({"channel": channel.as_str(), "probe": probe}),
        None => json!({"probe": probe}),
    };
    wire::operations_request(request_id, CHANNELS_STATUS_METHOD, params)
}

fn empty_channel_snapshot() -> ChannelStatusSnapshot {
    ChannelStatusSnapshot {
        ts: now_millis(),
        partial: false,
        warnings: Vec::new(),
        channel_order: Vec::new(),
        channels: BTreeMap::new(),
        channel_accounts: BTreeMap::new(),
        channel_default_account_id: BTreeMap::new(),
    }
}

fn offline_channel_snapshot(configured: &ConfiguredChannelAccounts) -> ChannelStatusSnapshot {
    let mut snapshot = empty_channel_snapshot();
    for channel in &configured.channels {
        snapshot.channel_order.push(channel.channel.clone());
        let mut summary = missing_configured_channel_summary(false);
        summary.running = Some(false);
        snapshot.channels.insert(channel.channel.clone(), summary);
        snapshot.channel_accounts.insert(
            channel.channel.clone(),
            channel
                .accounts
                .iter()
                .map(|account| {
                    let mut snapshot = configured_account_snapshot(account);
                    snapshot.running = Some(false);
                    snapshot.connected = Some(false);
                    snapshot
                })
                .collect(),
        );
        if let Some(account) = &channel.default_account_id {
            snapshot
                .channel_default_account_id
                .insert(channel.channel.clone(), account.clone());
        }
    }
    snapshot
}

fn now_millis() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    millis.min(u128::from(MAX_JSON_SAFE_INTEGER)) as u64
}

fn decode_channel_snapshot(
    response: GatewayResponse,
    configured: &ConfiguredChannelAccounts,
) -> Result<ChannelStatusSnapshot, ()> {
    let payload = match success_payload_object(response) {
        Ok(payload) => payload,
        Err(()) => {
            status_trace("status.decode", "field=payload outcome=invalid");
            return Err(());
        }
    };
    let partial = optional_partial(&payload)?;
    let warnings = public_status_warnings(&payload, partial)?;
    validate_event_loop(&payload)?;

    let ts = match payload
        .get("ts")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
    {
        Some(ts) => ts,
        None => {
            status_trace("status.decode", "field=ts outcome=invalid");
            return Err(());
        }
    };
    let channels = optional_object(&payload, "channels")?;
    let channel_accounts = optional_object(&payload, "channelAccounts")?;
    let native_defaults = optional_object(&payload, "channelDefaultAccountId")?;

    let mut summaries = BTreeMap::new();
    let mut accounts_by_channel = BTreeMap::new();
    let mut default_accounts = BTreeMap::new();
    for configured_channel in &configured.channels {
        let summary = channels
            .and_then(|channels| channels.get(&configured_channel.channel))
            .map(|value| decode_channel_summary(value))
            .transpose()?
            .unwrap_or_else(|| missing_configured_channel_summary(partial));

        let mut live_accounts = decode_live_account_map(
            channel_accounts.and_then(|accounts| accounts.get(&configured_channel.channel)),
            &configured_channel.accounts,
        )?;
        for account_id in &configured_channel.accounts {
            live_accounts
                .entry(account_id.clone())
                .or_insert_with(|| configured_account_snapshot(account_id));
        }
        let native_default = native_defaults
            .and_then(|defaults| defaults.get(&configured_channel.channel))
            .and_then(Value::as_str)
            .filter(|account| live_accounts.contains_key(*account));
        let default_account = native_default
            .map(str::to_owned)
            .or_else(|| configured_channel.default_account_id.clone())
            .or_else(|| live_accounts.keys().next().cloned());
        if let Some(default_account) = default_account {
            default_accounts.insert(configured_channel.channel.clone(), default_account);
        }
        summaries.insert(configured_channel.channel.clone(), summary);
        accounts_by_channel.insert(
            configured_channel.channel.clone(),
            live_accounts.into_values().collect(),
        );
    }

    Ok(ChannelStatusSnapshot {
        ts,
        partial,
        warnings,
        channel_order: configured
            .channels
            .iter()
            .map(|channel| channel.channel.clone())
            .collect(),
        channels: summaries,
        channel_accounts: accounts_by_channel,
        channel_default_account_id: default_accounts,
    })
}

fn optional_partial(payload: &Map<String, Value>) -> Result<bool, ()> {
    match payload.get("partial") {
        None | Some(Value::Null) => Ok(false),
        Some(value) => match value.as_bool() {
            Some(value) => Ok(value),
            None => {
                status_trace("status.decode", "field=partial outcome=invalid");
                Err(())
            }
        },
    }
}

fn public_status_warnings(payload: &Map<String, Value>, partial: bool) -> Result<Vec<String>, ()> {
    match payload.get("warnings") {
        None | Some(Value::Null) => Ok(public_status_warning(partial)),
        Some(Value::Array(values)) => {
            if values
                .iter()
                .any(|value| !matches!(value, Value::String(_)))
            {
                status_trace("status.decode", "field=warnings outcome=invalid_entry");
                return Err(());
            }
            Ok(public_status_warning(partial || !values.is_empty()))
        }
        Some(_) => {
            status_trace("status.decode", "field=warnings outcome=invalid_type");
            Err(())
        }
    }
}

fn public_status_warning(present: bool) -> Vec<String> {
    if present {
        vec![PUBLIC_CHANNEL_STATUS_ERROR.to_owned()]
    } else {
        Vec::new()
    }
}

fn validate_event_loop(payload: &Map<String, Value>) -> Result<(), ()> {
    match payload.get("eventLoop") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(_)) => Ok(()),
        Some(_) => {
            status_trace("status.decode", "field=eventLoop outcome=invalid");
            Err(())
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ConfiguredChannelAccounts {
    channels: Vec<ConfiguredChannel>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ConfiguredChannel {
    channel: String,
    accounts: Vec<String>,
    default_account_id: Option<String>,
}

fn configured_channel_accounts(document: &Value) -> Result<ConfiguredChannelAccounts, ()> {
    let Some(channels) = document.get("channels") else {
        return Ok(ConfiguredChannelAccounts {
            channels: Vec::new(),
        });
    };
    let channels = channels.as_object().ok_or(())?;
    let mut configured = Vec::new();
    for (channel, section) in channels {
        let channel = ChannelId::try_new(channel.clone()).map_err(|_| ())?;
        let Some(section) = section.as_object() else {
            continue;
        };
        if section.is_empty() || section.get("enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        let mut accounts = configured_accounts_in_section(channel.as_str(), section)?;
        accounts.sort();
        accounts.dedup();
        let default_account_id = configured_default_account(section, &accounts)?;
        configured.push(ConfiguredChannel {
            channel: channel.as_str().to_owned(),
            accounts,
            default_account_id,
        });
    }
    Ok(ConfiguredChannelAccounts {
        channels: configured,
    })
}

fn configured_accounts_in_section(
    channel: &str,
    section: &Map<String, Value>,
) -> Result<Vec<String>, ()> {
    if channel == super::weixin_login::OPENCLAW_WEIXIN_CHANNEL {
        return Ok(Vec::new());
    }
    let section_material = section_has_account_material(section);
    let Some(accounts) = section.get("accounts") else {
        return Ok(section_material
            .then(|| configured_default_or_fallback_account(section))
            .transpose()?
            .into_iter()
            .collect());
    };
    let accounts = accounts.as_object().ok_or(())?;
    if accounts.is_empty() && section_material {
        return Ok(vec![configured_default_or_fallback_account(section)?]);
    }
    let mut configured = Vec::new();
    for (account_id, account) in accounts {
        let account_id = AccountId::try_new(account_id.clone()).map_err(|_| ())?;
        if account_is_configured(section, account_id.as_str(), account, section_material) {
            configured.push(account_id.as_str().to_owned());
        }
    }
    Ok(configured)
}

fn account_is_configured(
    section: &Map<String, Value>,
    account_id: &str,
    account: &Value,
    section_material: bool,
) -> bool {
    match account {
        Value::Object(account) => {
            if account.get("enabled") == Some(&Value::Bool(false)) {
                return false;
            }
            account_has_config_material(account)
                || (section_material && default_account_matches(section, account_id))
        }
        Value::Null => false,
        _ => true,
    }
}

fn account_has_config_material(account: &Map<String, Value>) -> bool {
    account.get("enabled") == Some(&Value::Bool(true))
        || account.keys().any(|key| !matches!(key.as_str(), "proxy"))
}

fn section_has_account_material(section: &Map<String, Value>) -> bool {
    section.keys().any(|key| {
        !matches!(
            key.as_str(),
            "enabled" | "updatedAt" | "accounts" | "defaultAccount" | "proxy"
        )
    })
}

fn default_account_matches(section: &Map<String, Value>, account_id: &str) -> bool {
    section
        .get("defaultAccount")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("default")
        == account_id
}

fn configured_default_or_fallback_account(section: &Map<String, Value>) -> Result<String, ()> {
    AccountId::try_new(
        section
            .get("defaultAccount")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("default")
            .to_owned(),
    )
    .map(|account| account.as_str().to_owned())
    .map_err(|_| ())
}

fn configured_default_account(
    section: &Map<String, Value>,
    accounts: &[String],
) -> Result<Option<String>, ()> {
    if let Some(default_account) = section
        .get("defaultAccount")
        .and_then(Value::as_str)
        .and_then(|value| AccountId::try_new(value.to_owned()).ok())
        .map(|account| account.as_str().to_owned())
        .filter(|account| accounts.contains(account))
    {
        return Ok(Some(default_account));
    }
    Ok(accounts
        .iter()
        .find(|account| account.as_str() == "default")
        .or_else(|| accounts.first())
        .cloned())
}

fn optional_object<'a>(
    payload: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<&'a Map<String, Value>>, ()> {
    match payload.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(value)) => Ok(Some(value)),
        Some(_) => {
            status_trace(
                "status.decode",
                &format!("field={field} outcome=invalid_type"),
            );
            Err(())
        }
    }
}

fn missing_configured_channel_summary(partial: bool) -> ChannelSummarySnapshot {
    ChannelSummarySnapshot {
        configured: None,
        running: None,
        error: partial.then(|| PUBLIC_CHANNEL_STATUS_ERROR.to_owned()),
        last_error: None,
    }
}

fn configured_account_snapshot(account_id: &str) -> ChannelAccountSnapshot {
    ChannelAccountSnapshot {
        account_id: account_id.to_owned(),
        configured: None,
        connected: None,
        running: None,
        linked: None,
        last_error: None,
        name: None,
        last_connected_at: None,
        last_inbound_at: None,
        last_outbound_at: None,
        last_probe_at: None,
        probe: None,
    }
}

fn decode_live_account_map(
    value: Option<&Value>,
    configured_accounts: &[String],
) -> Result<BTreeMap<String, ChannelAccountSnapshot>, ()> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let accounts = match value.as_array() {
        Some(accounts) => accounts,
        None => {
            status_trace(
                "status.decode",
                "field=channelAccounts outcome=invalid_channel_value",
            );
            return Err(());
        }
    };
    let configured_accounts = configured_accounts
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for value in accounts {
        let account = match value.as_object() {
            Some(account) => account,
            None => {
                status_trace(
                    "status.decode",
                    "field=channelAccounts.account outcome=invalid_type",
                );
                return Err(());
            }
        };
        let Some(account_id) = account.get("accountId").and_then(Value::as_str) else {
            continue;
        };
        if !configured_accounts.contains(account_id)
            && account.get("configured") != Some(&Value::Bool(true))
        {
            continue;
        }
        let account_id = match AccountId::try_new(account_id.to_owned()) {
            Ok(account_id) => account_id,
            Err(_) => {
                status_trace(
                    "status.decode",
                    "field=channelAccounts.accountId outcome=invalid",
                );
                return Err(());
            }
        };
        let account_id = account_id.as_str().to_owned();
        if result
            .insert(
                account_id.clone(),
                decode_channel_account(account, account_id)?,
            )
            .is_some()
        {
            status_trace(
                "status.decode",
                "field=channelAccounts.accountId outcome=duplicate",
            );
            return Err(());
        }
    }
    Ok(result)
}

fn decode_channel_summary(value: &Value) -> Result<ChannelSummarySnapshot, ()> {
    let summary = match value.as_object() {
        Some(summary) => summary,
        None => {
            status_trace(
                "status.decode",
                "field=channels.summary outcome=invalid_type",
            );
            return Err(());
        }
    };
    Ok(ChannelSummarySnapshot {
        configured: optional_bool(summary, "channels.summary.configured")?,
        running: optional_bool(summary, "channels.summary.running")?,
        error: optional_public_error(summary, "error"),
        last_error: optional_public_error(summary, "lastError"),
    })
}

fn decode_channel_account(
    account: &Map<String, Value>,
    account_id: String,
) -> Result<ChannelAccountSnapshot, ()> {
    Ok(ChannelAccountSnapshot {
        account_id,
        configured: optional_bool(account, "channelAccounts.configured")?,
        connected: optional_bool(account, "channelAccounts.connected")?,
        running: optional_bool(account, "channelAccounts.running")?,
        linked: optional_bool(account, "channelAccounts.linked")?,
        last_error: optional_public_error(account, "lastError"),
        name: optional_text(account, "channelAccounts.name", "name")?,
        last_connected_at: optional_timestamp(
            account,
            "channelAccounts.lastConnectedAt",
            "lastConnectedAt",
        )?,
        last_inbound_at: optional_timestamp(
            account,
            "channelAccounts.lastInboundAt",
            "lastInboundAt",
        )?,
        last_outbound_at: optional_timestamp(
            account,
            "channelAccounts.lastOutboundAt",
            "lastOutboundAt",
        )?,
        last_probe_at: optional_timestamp(account, "channelAccounts.lastProbeAt", "lastProbeAt")?,
        probe: optional_probe(account)?,
    })
}

fn optional_bool(payload: &Map<String, Value>, field: &str) -> Result<Option<bool>, ()> {
    let source_field = field.rsplit('.').next().unwrap_or(field);
    match payload.get(source_field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match value.as_bool() {
            Some(value) => Ok(Some(value)),
            None => {
                status_trace(
                    "status.decode",
                    &format!("field={field} outcome=invalid_bool"),
                );
                Err(())
            }
        },
    }
}

fn optional_text(
    payload: &Map<String, Value>,
    trace_field: &str,
    source_field: &str,
) -> Result<Option<String>, ()> {
    match payload.get(source_field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => match normalize_status_text(value) {
            Some(value) => Ok(Some(value)),
            None => {
                status_trace(
                    "status.decode",
                    &format!("field={trace_field} outcome=invalid_text"),
                );
                Err(())
            }
        },
        Some(_) => {
            status_trace(
                "status.decode",
                &format!("field={trace_field} outcome=invalid_text_type"),
            );
            Err(())
        }
    }
}

fn optional_public_error(payload: &Map<String, Value>, field: &str) -> Option<String> {
    match payload.get(field) {
        Some(Value::String(value)) if normalize_status_text(value).is_some() => {
            Some(PUBLIC_CHANNEL_STATUS_ERROR.to_owned())
        }
        _ => None,
    }
}

fn optional_timestamp(
    payload: &Map<String, Value>,
    trace_field: &str,
    source_field: &str,
) -> Result<Option<Option<u64>>, ()> {
    match payload.get(source_field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => match value
            .as_u64()
            .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
            .map(|value| Some(Some(value)))
        {
            Some(value) => Ok(value),
            None => {
                status_trace(
                    "status.decode",
                    &format!("field={trace_field} outcome=invalid_timestamp"),
                );
                Err(())
            }
        },
    }
}

fn optional_probe(payload: &Map<String, Value>) -> Result<Option<ChannelProbeSnapshot>, ()> {
    match payload.get("probe") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(probe)) => match probe.get("ok").and_then(Value::as_bool) {
            Some(ok) => Ok(Some(ChannelProbeSnapshot { ok })),
            None => {
                status_trace(
                    "status.decode",
                    "field=channelAccounts.probe.ok outcome=invalid_bool",
                );
                Err(())
            }
        },
        Some(_) => {
            status_trace(
                "status.decode",
                "field=channelAccounts.probe outcome=invalid_type",
            );
            Err(())
        }
    }
}

fn normalize_status_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control))
        .then_some(value.to_owned())
}

#[cfg(test)]
fn decode_account_connection(
    response: GatewayResponse,
    expected_channel: &ChannelId,
    expected_account: &AccountId,
) -> Result<ChannelConnection, ()> {
    let payload = success_payload_object(response)?;
    let partial = optional_partial(&payload)?;
    let _ = public_status_warnings(&payload, partial)?;
    validate_event_loop(&payload)?;
    let channel_accounts = required_object(&payload, "channelAccounts")?;
    let snapshots = channel_accounts
        .get(expected_channel.as_str())
        .and_then(Value::as_array)
        .ok_or(())?;
    let mut connection = None;
    for snapshot in snapshots {
        let snapshot = snapshot.as_object().ok_or(())?;
        if snapshot.get("accountId").and_then(Value::as_str) != Some(expected_account.as_str()) {
            continue;
        }
        let connected = snapshot
            .get("connected")
            .and_then(Value::as_bool)
            .ok_or(())?;
        if connection.replace(connected).is_some() {
            return Err(());
        }
    }
    match connection {
        Some(true) => Ok(ChannelConnection::Connected),
        Some(false) => Ok(ChannelConnection::Disconnected),
        None => Err(()),
    }
}

fn success_payload_object(response: GatewayResponse) -> Result<Map<String, Value>, ()> {
    match response {
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } => Ok(payload),
        _ => Err(()),
    }
}

#[cfg(test)]
fn required_object<'a>(
    payload: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Map<String, Value>, ()> {
    payload.get(field).and_then(Value::as_object).ok_or(())
}

fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(string) => string.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(object) => object.values_mut().for_each(zeroize_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::{
        net::TcpListener,
        time::{Duration, timeout},
    };
    use tokio_tungstenite::tungstenite::Message;

    use crate::gateway::{
        auth::GatewaySecret,
        client::{
            GatewayClient, GatewayClientMetadata, GatewayEndpoint,
            test_support::{TestSocket, TestTlsIdentity, accept_websocket},
        },
        wire,
    };

    use super::*;

    fn response(payload: Value) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: "request".into(),
            payload: Some(payload),
        }
    }

    fn configured(document: Value) -> ConfiguredChannelAccounts {
        configured_channel_accounts(&document).unwrap()
    }

    #[test]
    fn configured_accounts_come_from_openclaw_config_accounts() {
        let configured = configured(json!({
            "channels": {
                "plugin-channel": {
                    "accounts": {
                        "primary": {"token": "secret"},
                        "disabled": {"enabled": false}
                    },
                    "defaultAccount": "primary"
                },
                "another-dynamic-channel": {
                    "accounts": {"secondary": "configured"}
                },
                "empty": {"accounts": {}}
            }
        }));

        assert_eq!(
            configured.channels,
            vec![
                ConfiguredChannel {
                    channel: "another-dynamic-channel".into(),
                    accounts: vec!["secondary".into()],
                    default_account_id: Some("secondary".into()),
                },
                ConfiguredChannel {
                    channel: "empty".into(),
                    accounts: vec![],
                    default_account_id: None,
                },
                ConfiguredChannel {
                    channel: "plugin-channel".into(),
                    accounts: vec!["primary".into()],
                    default_account_id: Some("primary".into()),
                }
            ]
        );
    }

    #[test]
    fn configured_accounts_ignore_empty_shell_and_proxy_only_accounts() {
        let configured = configured(json!({
            "channels": {
                "telegram": {
                    "defaultAccount": "default",
                    "accounts": {"default": {}}
                },
                "telegram-proxy": {
                    "defaultAccount": "default",
                    "accounts": {"default": {"proxy": "http://proxy.internal:8080"}}
                },
                "openclaw-weixin": {
                    "accounts": {"default": {"enabled": true}}
                }
            }
        }));

        assert_eq!(
            configured.channels,
            vec![
                ConfiguredChannel {
                    channel: "openclaw-weixin".into(),
                    accounts: vec![],
                    default_account_id: None
                },
                ConfiguredChannel {
                    channel: "telegram".into(),
                    accounts: vec![],
                    default_account_id: None
                },
                ConfiguredChannel {
                    channel: "telegram-proxy".into(),
                    accounts: vec![],
                    default_account_id: None
                },
            ]
        );
    }

    #[test]
    fn configured_accounts_reject_malformed_config_identities() {
        for document in [
            json!({"channels": []}),
            json!({"channels": {"bad channel": {"accounts": {"primary": {}}}}}),
            json!({"channels": {"discord": {"accounts": []}}}),
            json!({"channels": {"discord": {"accounts": {"bad account": {}}}}}),
        ] {
            assert!(configured_channel_accounts(&document).is_err());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn offline_snapshot_reads_native_config_and_weixin_index_without_rpc() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let root =
            std::env::temp_dir().join(format!("channel-status-{}", next_request_id("offline")));
        let state_dir = CanonicalStateDir::provision(&root).unwrap();
        std::fs::write(root.join("openclaw.json"), json!({
            "channels": {
                "openclaw-weixin": {"enabled": true, "accounts": {"default": {"enabled": true}}},
                "telegram": {"enabled": true}
            }
        }).to_string()).unwrap();
        let operation = ChannelStatusOperation::new(Arc::new(client), Some(state_dir), false);
        let ChannelSnapshotEffect::Observed(empty) = operation.observe_snapshot().await else {
            panic!("expected configured offline channels");
        };
        assert_eq!(empty.channel_order, vec!["openclaw-weixin", "telegram"]);
        assert!(empty.channel_accounts.values().all(Vec::is_empty));
        assert!(empty.channel_default_account_id.is_empty());
        assert!(
            empty
                .channels
                .values()
                .all(|summary| summary.configured.is_none() && summary.running == Some(false))
        );

        std::fs::create_dir(root.join("openclaw-weixin")).unwrap();
        std::fs::write(
            root.join("openclaw-weixin/accounts.json"),
            r#"["native-im-bot"]"#,
        )
        .unwrap();
        let ChannelSnapshotEffect::Observed(snapshot) = operation.observe_snapshot().await else {
            panic!("expected indexed native account");
        };
        let account = &snapshot.channel_accounts["openclaw-weixin"][0];
        assert_eq!(account.account_id, "native-im-bot");
        assert_eq!(account.configured, None);
        assert_eq!(account.connected, Some(false));
        assert_eq!(
            snapshot.channel_default_account_id["openclaw-weixin"],
            "native-im-bot"
        );
        assert!(
            timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn snapshot_accepts_public_config_when_raw_is_withheld() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let get = read_json(&mut socket).await;
            assert_eq!(get["method"], "config.get");
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": get["id"], "ok": true,
                    "payload": config_snapshot_with_raw(json!({}), Value::Null, None, false)
                }),
            )
            .await;
            assert_no_live_status_request(&mut socket).await;
        });

        let effect = ChannelStatusOperation::new(Arc::new(client), None, true)
            .observe_snapshot()
            .await;
        server.await.unwrap();

        let ChannelSnapshotEffect::Observed(snapshot) = effect else {
            panic!("expected observed empty snapshot");
        };
        assert_empty_snapshot(snapshot);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn snapshot_reads_configured_accounts_from_public_config_without_raw() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let get = read_json(&mut socket).await;
            assert_eq!(get["method"], "config.get");
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": get["id"], "ok": true,
                    "payload": config_snapshot_with_raw(
                        json!({"channels": {"telegram": {"accounts": {"primary": {"token": "secret"}}, "defaultAccount": "primary"}}}),
                        Value::Null,
                        None,
                        true,
                    )
                }),
            )
            .await;

            let status = read_json(&mut socket).await;
            assert_eq!(status["method"], CHANNELS_STATUS_METHOD);
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": status["id"], "ok": true,
                    "payload": {
                        "ts": 1,
                        "channels": {"telegram": {"configured": true, "running": true}},
                        "channelAccounts": {"telegram": [{"accountId": "primary", "connected": true, "running": true}]}
                    }
                }),
            )
            .await;
        });

        let effect = ChannelStatusOperation::new(Arc::new(client), None, true)
            .observe_snapshot()
            .await;
        server.await.unwrap();

        let ChannelSnapshotEffect::Observed(snapshot) = effect else {
            panic!("expected observed snapshot");
        };
        assert_eq!(snapshot.channel_order, vec!["telegram"]);
        assert_eq!(snapshot.channels["telegram"].configured, Some(true));
        assert_eq!(snapshot.channels["telegram"].running, Some(true));
        assert_eq!(
            snapshot.channel_accounts["telegram"][0].account_id,
            "primary"
        );
        assert_eq!(snapshot.channel_accounts["telegram"][0].configured, None);
        assert_eq!(
            snapshot.channel_accounts["telegram"][0].connected,
            Some(true)
        );
    }

    #[test]
    fn exact_probe_accepts_82_status_extras_and_full_status_map() {
        let channel = ChannelId::try_new("discord".into()).unwrap();
        let account = AccountId::try_new("primary".into()).unwrap();
        for last_probe_at in [0, MAX_JSON_SAFE_INTEGER] {
            assert_eq!(
                decode_account_connection(
                    response(json!({
                        "partial": true,
                        "warnings": ["native warning not projected"],
                        "eventLoop": {"degraded": false},
                        "channelAccounts": {
                            "discord": [{
                                "accountId": "primary", "connected": true, "lastProbeAt": last_probe_at
                            }],
                            "lark": [{
                                "accountId": "main", "connected": false, "lastProbeAt": 1
                            }]
                        }
                    })),
                    &channel,
                    &account,
                ),
                Ok(ChannelConnection::Connected)
            );
        }
    }

    #[test]
    fn exact_probe_request_has_only_the_native_channel_and_probe_parameters() {
        let channel = ChannelId::try_new("discord".into()).unwrap();
        let request = channel_status_request("request".into(), Some(&channel), true).unwrap();
        let encoded: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        assert_eq!(encoded["method"], CHANNELS_STATUS_METHOD);
        assert_eq!(
            encoded["params"],
            json!({"channel": "discord", "probe": true})
        );
    }

    #[test]
    fn snapshot_accepts_82_status_extras_without_projecting_native_details() {
        let configured = configured(json!({
            "channels": {"discord": {"accounts": {"primary": {"token": "secret"}}}}
        }));
        let snapshot = decode_channel_snapshot(
            response(json!({
                "ts": 1_700_000_000_000_u64,
                "partial": true,
                "warnings": ["native warning with private path C:/secret/openclaw.json"],
                "eventLoop": {"degraded": true, "reasons": ["event_loop_delay"], "delayP99Ms": 62_000, "token": "secret"},
                "channelMeta": [{"id": "discord", "label": "Discord", "detailLabel": "Bot API", "private": "secret"}],
                "channels": {"discord": {"configured": true}},
                "channelAccounts": {"discord": [{"accountId": "primary", "running": true}]}
            })),
            &configured,
        )
        .unwrap();

        assert!(snapshot.partial);
        assert_eq!(snapshot.warnings, vec![PUBLIC_CHANNEL_STATUS_ERROR]);
        assert_eq!(snapshot.channel_order, vec!["discord"]);
        assert_eq!(snapshot.channel_default_account_id["discord"], "primary");
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("eventLoop"));
        assert!(!encoded.contains("secret"));
        assert!(!encoded.contains("Discord"));
    }

    #[test]
    fn snapshot_projects_renderer_fields_and_drops_native_private_fields() {
        let configured = configured(json!({
            "channels": {"discord": {"accounts": {"primary": {"token": "secret"}}}}
        }));
        let snapshot = decode_channel_snapshot(
            response(json!({
                "ts": 1_700_000_000_000_u64,
                "channelOrder": ["discord"],
                "channels": {
                    "discord": {
                        "configured": false,
                        "running": true,
                        "lastError": "summary failure",
                        "token": "must-not-project"
                    }
                },
                "channelAccounts": {
                    "discord": [{
                        "accountId": "primary",
                        "name": "Primary",
                        "configured": false,
                        "connected": true,
                        "running": true,
                        "linked": true,
                        "lastError": "account failure",
                        "lastConnectedAt": 10,
                        "lastInboundAt": null,
                        "lastOutboundAt": 20,
                        "lastProbeAt": 30,
                        "probe": {"ok": true, "error": "private probe error", "token": "secret"},
                        "tokenSource": "must-not-project",
                        "baseUrl": "https://secret.example.invalid",
                        "audit": {"ok": true},
                        "application": {"id": "private"}
                    }]
                },
                "channelDefaultAccountId": {"discord": "stale"}
            })),
            &configured,
        )
        .unwrap();

        assert_eq!(snapshot.channel_order, vec!["discord"]);
        assert_eq!(snapshot.channels["discord"].configured, Some(false));
        assert_eq!(snapshot.channels["discord"].running, Some(true));
        assert_eq!(
            snapshot.channels["discord"].last_error.as_deref(),
            Some(PUBLIC_CHANNEL_STATUS_ERROR)
        );
        assert_eq!(
            snapshot.channel_accounts["discord"][0].account_id,
            "primary"
        );
        assert_eq!(
            snapshot.channel_accounts["discord"][0].configured,
            Some(false)
        );
        assert_eq!(snapshot.channel_accounts["discord"][0].running, Some(true));
        assert_eq!(
            snapshot.channel_accounts["discord"][0]
                .last_error
                .as_deref(),
            Some(PUBLIC_CHANNEL_STATUS_ERROR)
        );
        assert_eq!(
            snapshot.channel_accounts["discord"][0].last_inbound_at,
            Some(None)
        );
        assert_eq!(
            snapshot.channel_accounts["discord"][0].probe,
            Some(ChannelProbeSnapshot { ok: true })
        );
        assert_eq!(snapshot.channel_default_account_id["discord"], "primary");

        let encoded = serde_json::to_string(&snapshot).unwrap();
        for secret in [
            "must-not-project",
            "secret.example.invalid",
            "private probe error",
            "summary failure",
            "account failure",
            "private",
        ] {
            assert!(!encoded.contains(secret), "projection leaked {secret}");
        }
    }

    #[test]
    fn snapshot_includes_native_configured_accounts_missing_from_config() {
        let configured = configured(json!({
            "channels": {"openclaw-weixin": {"enabled": true, "accounts": {"default": {"enabled": true}}}}
        }));
        let snapshot = decode_channel_snapshot(
            response(json!({
                "ts": 1,
                "channels": {"openclaw-weixin": {"configured": true}},
                "channelAccounts": {"openclaw-weixin": [
                    {"accountId": "native-im-bot", "configured": true, "connected": true},
                    {"accountId": "default", "configured": false}
                ]},
                "channelDefaultAccountId": {"openclaw-weixin": "native-im-bot"}
            })),
            &configured,
        )
        .unwrap();
        assert_eq!(snapshot.channel_order, vec!["openclaw-weixin"]);
        let accounts = &snapshot.channel_accounts["openclaw-weixin"];
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account_id, "native-im-bot");
        assert_eq!(accounts[0].configured, Some(true));
        assert_eq!(accounts[0].connected, Some(true));
        assert_eq!(
            snapshot.channel_default_account_id["openclaw-weixin"],
            "native-im-bot"
        );
    }

    #[test]
    fn snapshot_enriches_configured_account_with_gateway_live_status() {
        let configured = configured(json!({
            "channels": {"discord": {"accounts": {"primary": {"token": "secret"}}, "defaultAccount": "primary"}}
        }));
        let snapshot = decode_channel_snapshot(
            response(json!({
                "ts": 1,
                "channels": {"discord": {"configured": false, "running": true, "lastError": "summary failure"}},
                "channelAccounts": {"discord": [{
                    "accountId": "primary",
                    "configured": false,
                    "connected": true,
                    "running": true,
                    "lastError": "account failure",
                    "lastProbeAt": 7,
                    "probe": {"ok": true}
                }]}
            })),
            &configured,
        )
        .unwrap();

        assert_eq!(snapshot.channels["discord"].configured, Some(false));
        assert_eq!(snapshot.channels["discord"].running, Some(true));
        let account = &snapshot.channel_accounts["discord"][0];
        assert_eq!(account.account_id, "primary");
        assert_eq!(account.configured, Some(false));
        assert_eq!(account.connected, Some(true));
        assert_eq!(account.running, Some(true));
        assert_eq!(account.last_probe_at, Some(Some(7)));
        assert_eq!(account.probe, Some(ChannelProbeSnapshot { ok: true }));
    }

    #[test]
    fn snapshot_rejects_malformed_status_extras_timestamps_and_duplicate_configured_accounts() {
        let configured = configured(json!({
            "channels": {"discord": {"accounts": {"primary": {"token": "secret"}}}}
        }));
        let base = json!({
            "ts": 1,
            "channelOrder": ["discord"],
            "channels": {"discord": {"configured": true}},
            "channelAccounts": {"discord": [{"accountId": "primary"}]},
            "channelDefaultAccountId": {"discord": "primary"}
        });
        for (field, value) in [
            ("partial", json!("yes")),
            ("warnings", json!([7])),
            ("eventLoop", json!("running")),
        ] {
            let mut payload = base.clone();
            payload[field] = value;
            assert!(decode_channel_snapshot(response(payload), &configured).is_err());
        }

        let mut malformed_timestamp = base.clone();
        malformed_timestamp["channelAccounts"]["discord"][0]["lastProbeAt"] =
            json!(MAX_JSON_SAFE_INTEGER + 1);
        assert!(decode_channel_snapshot(response(malformed_timestamp), &configured).is_err());

        let mut duplicate = base;
        duplicate["channelAccounts"]["discord"] = json!([
            {"accountId": "primary"},
            {"accountId": "primary"}
        ]);
        assert!(decode_channel_snapshot(response(duplicate), &configured).is_err());
    }

    #[test]
    fn snapshot_accepts_empty_native_channel_result() {
        let configured = configured(json!({}));
        let snapshot = decode_channel_snapshot(
            response(json!({
                "ts": 0,
                "channelOrder": [],
                "channels": {},
                "channelAccounts": {},
                "channelDefaultAccountId": {}
            })),
            &configured,
        )
        .unwrap();
        assert!(snapshot.channel_order.is_empty());
        assert!(snapshot.channels.is_empty());
        assert!(snapshot.channel_accounts.is_empty());
        assert!(snapshot.channel_default_account_id.is_empty());
    }

    #[test]
    fn partial_snapshot_preserves_configured_channels_with_missing_live_maps() {
        let configured = configured(json!({
            "channels": {
                "discord": {"accounts": {"primary": {"token": "secret"}}},
                "lark": {"accounts": {"main": {"appId": "app"}}}
            }
        }));
        let snapshot = decode_channel_snapshot(
            response(json!({
                "ts": 1,
                "partial": true,
                "channelOrder": ["discord", "stale"],
                "channels": {"discord": {"configured": true}},
                "channelAccounts": {"discord": [{"accountId": "primary"}]},
                "channelDefaultAccountId": {"discord": "primary"}
            })),
            &configured,
        )
        .unwrap();

        assert_eq!(snapshot.channel_order, vec!["discord", "lark"]);
        assert_eq!(snapshot.channels["lark"].configured, None);
        assert_eq!(
            snapshot.channels["lark"].error.as_deref(),
            Some(PUBLIC_CHANNEL_STATUS_ERROR)
        );
        assert_eq!(
            snapshot.channel_accounts["lark"],
            vec![configured_account_snapshot("main")]
        );
        assert_eq!(snapshot.channel_default_account_id["lark"], "main");
    }

    fn test_client(
        listener: &TcpListener,
        certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
    ) -> GatewayClient {
        GatewayClient::new(
            GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
            certificate_fingerprint,
            Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
            GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
        )
    }

    async fn serve_hello(socket: &mut TestSocket) {
        send_json(
            socket,
            json!({
                "type": "event", "event": "connect.challenge",
                "payload": {"nonce": "fake-nonce", "ts": 42}
            }),
        )
        .await;
        let connect = read_json(socket).await;
        assert_eq!(connect["method"], "connect");
        send_json(
            socket,
            json!({
                "type": "res", "id": connect["id"], "ok": true,
                "payload": {
                    "type": "hello-ok", "protocol": 4,
                    "server": {"version": wire::OPENCLAW_GATEWAY_VERSION, "connId": "fixture"},
                    "features": {
                        "methods": [
                            "status",
                            "config.get",
                            "config.patch",
                            "config.apply",
                            "plugins.refresh",
                            "agents.list",
                            "skills.status",
                            wire::SYSTEM_PRESENCE_METHOD
                        ],
                        "events": ["tick"]
                    },
                    "snapshot": {
                        "presence": [], "health": {"ok": true},
                        "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 1
                    },
                    "auth": {
                        "role": "operator",
                        "scopes": ["operator.read", "operator.write", "operator.admin", "operator.approvals"]
                    },
                    "policy": {
                        "maxPayload": 26214400, "maxBufferedBytes": 52428800,
                        "tickIntervalMs": 15000
                    }
                }
            }),
        )
        .await;
    }

    fn config_snapshot_with_raw(
        config: Value,
        raw: Value,
        hash: Option<&str>,
        valid: bool,
    ) -> Value {
        let mut snapshot = json!({
            "path": "openclaw.json",
            "exists": true,
            "raw": raw,
            "parsed": {},
            "sourceConfig": {},
            "resolved": {},
            "valid": valid,
            "runtimeConfig": {},
            "config": config,
            "issues": [],
            "warnings": [],
            "legacyIssues": []
        });
        if let Some(hash) = hash {
            snapshot["hash"] = Value::String(hash.to_owned());
        }
        snapshot
    }

    fn assert_empty_snapshot(snapshot: ChannelStatusSnapshot) {
        assert!(!snapshot.partial);
        assert!(snapshot.warnings.is_empty());
        assert!(snapshot.channel_order.is_empty());
        assert!(snapshot.channels.is_empty());
        assert!(snapshot.channel_accounts.is_empty());
        assert!(snapshot.channel_default_account_id.is_empty());
    }

    async fn assert_no_live_status_request(socket: &mut TestSocket) {
        match timeout(Duration::from_millis(50), socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_ne!(value["method"], CHANNELS_STATUS_METHOD);
            }
            Ok(Some(Ok(_))) | Ok(Some(Err(_))) | Ok(None) | Err(_) => {}
        }
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
}
