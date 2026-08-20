use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::Arc,
};

use serde_json::{Map, Value, json};

use crate::gateway::{
    client::GatewayClient,
    wire::{self, GatewayResponse},
};

use super::{
    OperationsReadError,
    channel_identity::{AccountId, ChannelId},
    next_request_id, read_gateway,
};

const CHANNELS_STATUS_METHOD: &str = "channels.status";
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PUBLIC_CHANNEL_STATUS_ERROR: &str = "Channel status reported an error";

/// Read-only native channel-account observation. The Gateway remains the sole
/// source of account discovery and connection facts; this operation exposes
/// only the account identity and live probe result. Native configuration,
/// secrets, warnings, and other fields are deliberately not projected.
pub struct ChannelStatusOperation {
    gateway: Arc<GatewayClient>,
}

impl ChannelStatusOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn observe(&self) -> ChannelStatusEffect {
        let accounts = match self.discover_accounts().await {
            Ok(accounts) => accounts,
            Err(ChannelStatusReadError::Rejected) => return ChannelStatusEffect::RuntimeRejected,
            Err(ChannelStatusReadError::Unknown) => return ChannelStatusEffect::OutcomeUnknown,
        };

        let mut observations = Vec::with_capacity(accounts.len());
        for (channel, account) in accounts {
            let connection = self.probe_account(&channel, &account).await;
            observations.push(ChannelAccountStatus {
                channel: channel.as_str().to_owned(),
                account_id: account.as_str().to_owned(),
                connection,
            });
        }
        ChannelStatusEffect::Observed(ChannelStatusReceipt { observations })
    }

    pub async fn observe_snapshot(&self) -> ChannelSnapshotEffect {
        let request =
            match channel_status_request(next_request_id("channel-status-snapshot"), None, false) {
                Ok(request) => request,
                Err(_) => return ChannelSnapshotEffect::OutcomeUnknown,
            };
        let response = match read_gateway(&self.gateway, request).await {
            Ok(response) => response,
            Err(OperationsReadError::Rejected) => return ChannelSnapshotEffect::RuntimeRejected,
            Err(_) => return ChannelSnapshotEffect::OutcomeUnknown,
        };
        match decode_channel_snapshot(response) {
            Ok(snapshot) => ChannelSnapshotEffect::Observed(snapshot),
            Err(()) => ChannelSnapshotEffect::OutcomeUnknown,
        }
    }

    async fn discover_accounts(
        &self,
    ) -> Result<Vec<(ChannelId, AccountId)>, ChannelStatusReadError> {
        let request =
            channel_status_request(next_request_id("channel-status-discovery"), None, false)
                .map_err(|_| ChannelStatusReadError::Unknown)?;
        let response = read_gateway(&self.gateway, request)
            .await
            .map_err(ChannelStatusReadError::from)?;
        match response {
            GatewayResponse::Failure { .. } => Err(ChannelStatusReadError::Rejected),
            response => decode_account_set(response).map_err(|_| ChannelStatusReadError::Unknown),
        }
    }

    async fn probe_account(&self, channel: &ChannelId, account: &AccountId) -> ChannelConnection {
        let request =
            match channel_status_request(next_request_id("channel-status"), Some(channel), true) {
                Ok(request) => request,
                Err(_) => return ChannelConnection::Unknown,
            };
        let response = match read_gateway(&self.gateway, request).await {
            Ok(response) => response,
            Err(_) => return ChannelConnection::Unknown,
        };
        match response {
            GatewayResponse::Failure { .. } => ChannelConnection::Unknown,
            response => decode_account_connection(response, channel, account)
                .unwrap_or(ChannelConnection::Unknown),
        }
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

fn channel_status_request(
    request_id: String,
    channel: Option<&ChannelId>,
    probe: bool,
) -> Result<wire::RpcRequest, wire::WireError> {
    let params = match channel {
        Some(channel) => json!({"channel": channel.as_str(), "probe": probe}),
        None => json!({}),
    };
    wire::operations_request(request_id, CHANNELS_STATUS_METHOD, params)
}

fn decode_channel_snapshot(response: GatewayResponse) -> Result<ChannelStatusSnapshot, ()> {
    let payload = success_payload_object(response)?;
    if payload.get("partial").and_then(Value::as_bool) == Some(true)
        || payload.contains_key("warnings")
    {
        return Err(());
    }

    let ts = payload
        .get("ts")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
        .ok_or(())?;
    let channel_order = payload
        .get("channelOrder")
        .and_then(Value::as_array)
        .ok_or(())?
        .iter()
        .map(|value| {
            value
                .as_str()
                .and_then(|value| ChannelId::try_new(value.to_owned()).ok())
                .map(|value| value.as_str().to_owned())
                .ok_or(())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let channel_keys = channel_order.iter().collect::<BTreeSet<_>>();
    if channel_keys.len() != channel_order.len() {
        return Err(());
    }

    let channels = required_object(&payload, "channels")?;
    let channel_accounts = required_object(&payload, "channelAccounts")?;
    let defaults = required_object(&payload, "channelDefaultAccountId")?;
    if !has_exact_keys(channels, &channel_keys)
        || !has_exact_keys(channel_accounts, &channel_keys)
        || !has_exact_keys(defaults, &channel_keys)
    {
        return Err(());
    }

    let mut summaries = BTreeMap::new();
    let mut accounts_by_channel = BTreeMap::new();
    let mut default_accounts = BTreeMap::new();
    for channel in &channel_order {
        let summary = decode_channel_summary(channels.get(channel).ok_or(())?)?;
        let accounts = decode_channel_accounts(channel_accounts.get(channel).ok_or(())?)?;
        let default_account = defaults
            .get(channel)
            .and_then(Value::as_str)
            .and_then(|value| AccountId::try_new(value.to_owned()).ok())
            .ok_or(())?;
        summaries.insert(channel.clone(), summary);
        accounts_by_channel.insert(channel.clone(), accounts);
        default_accounts.insert(channel.clone(), default_account.as_str().to_owned());
    }

    Ok(ChannelStatusSnapshot {
        ts,
        channel_order,
        channels: summaries,
        channel_accounts: accounts_by_channel,
        channel_default_account_id: default_accounts,
    })
}

fn decode_channel_summary(value: &Value) -> Result<ChannelSummarySnapshot, ()> {
    let summary = value.as_object().ok_or(())?;
    Ok(ChannelSummarySnapshot {
        configured: optional_bool(summary, "configured")?,
        running: optional_bool(summary, "running")?,
        error: optional_public_error(summary, "error")?,
        last_error: optional_public_error(summary, "lastError")?,
    })
}

fn decode_channel_accounts(value: &Value) -> Result<Vec<ChannelAccountSnapshot>, ()> {
    let accounts = value.as_array().ok_or(())?;
    let mut seen = BTreeSet::new();
    accounts
        .iter()
        .map(|value| {
            let account = value.as_object().ok_or(())?;
            let account_id = account
                .get("accountId")
                .and_then(Value::as_str)
                .and_then(|value| AccountId::try_new(value.to_owned()).ok())
                .ok_or(())?;
            if !seen.insert(account_id.as_str().to_owned()) {
                return Err(());
            }
            Ok(ChannelAccountSnapshot {
                account_id: account_id.as_str().to_owned(),
                configured: optional_bool(account, "configured")?,
                connected: optional_bool(account, "connected")?,
                running: optional_bool(account, "running")?,
                linked: optional_bool(account, "linked")?,
                last_error: optional_public_error(account, "lastError")?,
                name: optional_text(account, "name")?,
                last_connected_at: optional_timestamp(account, "lastConnectedAt")?,
                last_inbound_at: optional_timestamp(account, "lastInboundAt")?,
                last_outbound_at: optional_timestamp(account, "lastOutboundAt")?,
                last_probe_at: optional_timestamp(account, "lastProbeAt")?,
                probe: optional_probe(account)?,
            })
        })
        .collect()
}

fn has_exact_keys(payload: &Map<String, Value>, expected: &BTreeSet<&String>) -> bool {
    payload.len() == expected.len() && payload.keys().all(|key| expected.contains(key))
}

fn optional_bool(payload: &Map<String, Value>, field: &str) -> Result<Option<bool>, ()> {
    match payload.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_bool().map(Some).ok_or(()),
    }
}

fn optional_text(payload: &Map<String, Value>, field: &str) -> Result<Option<String>, ()> {
    match payload.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => normalize_status_text(value).map(Some).ok_or(()),
        Some(_) => Err(()),
    }
}

fn optional_public_error(payload: &Map<String, Value>, field: &str) -> Result<Option<String>, ()> {
    match payload.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => normalize_status_text(value)
            .map(|_| PUBLIC_CHANNEL_STATUS_ERROR.to_owned())
            .map(Some)
            .ok_or(()),
        Some(_) => Err(()),
    }
}

fn optional_timestamp(
    payload: &Map<String, Value>,
    field: &str,
) -> Result<Option<Option<u64>>, ()> {
    match payload.get(field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
            .map(|value| Some(Some(value)))
            .ok_or(()),
    }
}

fn optional_probe(payload: &Map<String, Value>) -> Result<Option<ChannelProbeSnapshot>, ()> {
    match payload.get("probe") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(probe)) => Ok(Some(ChannelProbeSnapshot {
            ok: probe.get("ok").and_then(Value::as_bool).ok_or(())?,
        })),
        Some(_) => Err(()),
    }
}

fn normalize_status_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control))
        .then_some(value.to_owned())
}

fn decode_account_set(response: GatewayResponse) -> Result<Vec<(ChannelId, AccountId)>, ()> {
    let payload = success_payload_object(response)?;
    if payload.get("partial").and_then(Value::as_bool) == Some(true)
        || payload.get("warnings").is_some()
    {
        return Err(());
    }
    let channel_accounts = required_object(&payload, "channelAccounts")?;
    let mut accounts = BTreeSet::new();
    for (channel, snapshots) in channel_accounts {
        let channel = ChannelId::try_new(channel.clone()).map_err(|_| ())?;
        let snapshots = snapshots.as_array().ok_or(())?;
        for snapshot in snapshots {
            let snapshot = snapshot.as_object().ok_or(())?;
            let account = snapshot
                .get("accountId")
                .and_then(Value::as_str)
                .ok_or(())?;
            let account = AccountId::try_new(account.into()).map_err(|_| ())?;
            if !accounts.insert((channel.clone(), account)) {
                return Err(());
            }
        }
    }
    Ok(accounts.into_iter().collect())
}

fn decode_account_connection(
    response: GatewayResponse,
    expected_channel: &ChannelId,
    expected_account: &AccountId,
) -> Result<ChannelConnection, ()> {
    let payload = success_payload_object(response)?;
    if payload.get("partial").and_then(Value::as_bool) == Some(true)
        || payload.get("warnings").is_some()
    {
        return Err(());
    }
    let channel_accounts = required_object(&payload, "channelAccounts")?;
    if channel_accounts.len() != 1 {
        return Err(());
    }
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
        let last_probe_at = snapshot
            .get("lastProbeAt")
            .and_then(Value::as_u64)
            .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
            .ok_or(())?;
        let _ = last_probe_at;
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

fn required_object<'a>(
    payload: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Map<String, Value>, ()> {
    payload.get(field).and_then(Value::as_object).ok_or(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn response(payload: Value) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: "request".into(),
            payload: Some(payload),
        }
    }

    #[test]
    fn discovery_accepts_dynamic_accounts_without_projecting_native_config() {
        let accounts = decode_account_set(response(json!({
            "channelAccounts": {
                "plugin-channel": [{"accountId": "primary", "configured": true}],
                "another-dynamic-channel": [{"accountId": "secondary", "configured": false}]
            }
        })))
        .unwrap();

        assert_eq!(
            accounts
                .iter()
                .map(|(channel, account)| (channel.as_str(), account.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("another-dynamic-channel", "secondary"),
                ("plugin-channel", "primary")
            ]
        );
    }

    #[test]
    fn discovery_rejects_partial_warnings_duplicates_and_malformed_accounts() {
        for payload in [
            json!({
                "partial": true,
                "channelAccounts": {"discord": [{"accountId": "primary"}]}
            }),
            json!({
                "warnings": [],
                "channelAccounts": {"discord": [{"accountId": "primary"}]}
            }),
            json!({
                "channelAccounts": {"discord": [
                    {"accountId": "primary"}, {"accountId": "primary"}
                ]}
            }),
            json!({
                "channelAccounts": {"discord": [{"accountId": 42}]}
            }),
            json!({"channelAccounts": {"discord": {"accountId": "primary"}}}),
        ] {
            assert!(decode_account_set(response(payload)).is_err());
        }
    }

    #[test]
    fn exact_probe_preserves_zero_last_probe_at_as_live_without_a_freshness_window() {
        let channel = ChannelId::try_new("discord".into()).unwrap();
        let account = AccountId::try_new("primary".into()).unwrap();
        for last_probe_at in [0, MAX_JSON_SAFE_INTEGER] {
            assert_eq!(
                decode_account_connection(
                    response(json!({
                        "channelAccounts": {"discord": [{
                            "accountId": "primary", "connected": true, "lastProbeAt": last_probe_at
                        }]}
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
    fn snapshot_projects_renderer_fields_and_drops_native_private_fields() {
        let snapshot = decode_channel_snapshot(response(json!({
            "ts": 1_700_000_000_000_u64,
            "channelOrder": ["discord"],
            "channels": {
                "discord": {
                    "configured": true,
                    "running": true,
                    "lastError": "summary failure",
                    "token": "must-not-project"
                }
            },
            "channelAccounts": {
                "discord": [{
                    "accountId": "primary",
                    "name": "Primary",
                    "configured": true,
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
            "channelDefaultAccountId": {"discord": "primary"}
        })))
        .unwrap();

        assert_eq!(snapshot.channel_order, vec!["discord"]);
        assert_eq!(snapshot.channels["discord"].configured, Some(true));
        assert_eq!(
            snapshot.channels["discord"].last_error.as_deref(),
            Some(PUBLIC_CHANNEL_STATUS_ERROR)
        );
        assert_eq!(
            snapshot.channel_accounts["discord"][0].account_id,
            "primary"
        );
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
    fn snapshot_rejects_partial_warnings_malformed_timestamps_and_duplicate_accounts() {
        let base = json!({
            "ts": 1,
            "channelOrder": ["discord"],
            "channels": {"discord": {"configured": true}},
            "channelAccounts": {"discord": [{"accountId": "primary"}]},
            "channelDefaultAccountId": {"discord": "primary"}
        });
        for (field, value) in [("partial", json!(true)), ("warnings", json!([]))] {
            let mut payload = base.clone();
            payload[field] = value;
            assert!(decode_channel_snapshot(response(payload)).is_err());
        }

        let mut malformed_timestamp = base.clone();
        malformed_timestamp["channelAccounts"]["discord"][0]["lastProbeAt"] =
            json!(MAX_JSON_SAFE_INTEGER + 1);
        assert!(decode_channel_snapshot(response(malformed_timestamp)).is_err());

        let mut duplicate = base;
        duplicate["channelAccounts"]["discord"] = json!([
            {"accountId": "primary"},
            {"accountId": "primary"}
        ]);
        assert!(decode_channel_snapshot(response(duplicate)).is_err());
    }

    #[test]
    fn snapshot_accepts_empty_native_channel_result() {
        let snapshot = decode_channel_snapshot(response(json!({
            "ts": 0,
            "channelOrder": [],
            "channels": {},
            "channelAccounts": {},
            "channelDefaultAccountId": {}
        })))
        .unwrap();
        assert!(snapshot.channel_order.is_empty());
        assert!(snapshot.channels.is_empty());
        assert!(snapshot.channel_accounts.is_empty());
        assert!(snapshot.channel_default_account_id.is_empty());
    }
}
