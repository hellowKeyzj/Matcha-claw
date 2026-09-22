use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPairingRequest {
    pub id: String,
    pub created_at: String,
    pub last_seen_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<ChannelPairingRequestMeta>,
    pub status: ChannelPairingRequestStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPairingRequestMeta {
    account_id: String,
}

impl ChannelPairingRequestMeta {
    pub fn new(account_id: String) -> Self {
        Self { account_id }
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelPairingRequestStatus {
    Pending,
    Unknown,
}

impl ChannelPairingRequestStatus {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ChannelPairingList {
    requests: Vec<ChannelPairingRequest>,
}

impl ChannelPairingList {
    pub fn new(requests: Vec<ChannelPairingRequest>) -> Self {
        Self { requests }
    }

    pub fn requests(&self) -> &[ChannelPairingRequest] {
        &self.requests
    }
}

impl ChannelPairingRequest {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn created_at(&self) -> &str {
        &self.created_at
    }

    pub fn last_seen_at(&self) -> &str {
        &self.last_seen_at
    }

    pub fn meta(&self) -> Option<&ChannelPairingRequestMeta> {
        self.meta.as_ref()
    }

    pub fn status(&self) -> ChannelPairingRequestStatus {
        self.status
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelPairingOutcome {
    Listed(Vec<ChannelPairingRequest>),
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelPairingApprovalOutcome {
    Confirmed,
    TargetRejected,
    Unknown,
}

impl ChannelPairingApprovalOutcome {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::TargetRejected => "target_rejected",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAccountStatus {
    channel: String,
    account_id: String,
    connection: ChannelConnection,
}

impl ChannelAccountStatus {
    pub fn new(channel: String, account_id: String, connection: ChannelConnection) -> Self {
        Self {
            channel,
            account_id,
            connection,
        }
    }

    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn connection(&self) -> ChannelConnection {
        self.connection
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelConnection {
    Connected,
    Disconnected,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatusOutcome {
    accounts: Vec<ChannelAccountStatus>,
}

impl ChannelStatusOutcome {
    pub fn new(accounts: Vec<ChannelAccountStatus>) -> Self {
        Self { accounts }
    }

    pub fn accounts(&self) -> &[ChannelAccountStatus] {
        &self.accounts
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSnapshotOutcome {
    ts: u64,
    #[serde(skip_serializing_if = "is_true")]
    ready: bool,
    #[serde(skip_serializing_if = "is_false")]
    refreshing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    channel_order: Vec<String>,
    channels: BTreeMap<String, ChannelSummarySnapshot>,
    channel_accounts: BTreeMap<String, Vec<ChannelAccountSnapshot>>,
    channel_default_account_id: BTreeMap<String, String>,
}

impl ChannelSnapshotOutcome {
    pub fn new(
        ts: u64,
        ready: bool,
        refreshing: bool,
        error: Option<String>,
        channel_order: Vec<String>,
        channels: BTreeMap<String, ChannelSummarySnapshot>,
        channel_accounts: BTreeMap<String, Vec<ChannelAccountSnapshot>>,
        channel_default_account_id: BTreeMap<String, String>,
    ) -> Self {
        Self {
            ts,
            ready,
            refreshing,
            error,
            channel_order,
            channels,
            channel_accounts,
            channel_default_account_id,
        }
    }

    pub fn ts(&self) -> u64 {
        self.ts
    }

    pub fn ready(&self) -> bool {
        self.ready
    }

    pub fn refreshing(&self) -> bool {
        self.refreshing
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn channel_order(&self) -> &[String] {
        &self.channel_order
    }

    pub fn channels(&self) -> &BTreeMap<String, ChannelSummarySnapshot> {
        &self.channels
    }

    pub fn channel_accounts(&self) -> &BTreeMap<String, Vec<ChannelAccountSnapshot>> {
        &self.channel_accounts
    }

    pub fn channel_default_account_id(&self) -> &BTreeMap<String, String> {
        &self.channel_default_account_id
    }
}

const fn is_true(value: &bool) -> bool {
    *value
}

const fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSummarySnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    configured: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
}

impl ChannelSummarySnapshot {
    pub fn new(
        configured: Option<bool>,
        running: Option<bool>,
        error: Option<String>,
        last_error: Option<String>,
    ) -> Self {
        Self {
            configured,
            running,
            error,
            last_error,
        }
    }

    pub fn configured(&self) -> Option<bool> {
        self.configured
    }

    pub fn running(&self) -> Option<bool> {
        self.running
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAccountSnapshot {
    account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    configured: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    linked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_connected_at: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_inbound_at: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_outbound_at: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_probe_at: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    probe: Option<ChannelProbeSnapshot>,
}

impl ChannelAccountSnapshot {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        account_id: String,
        configured: Option<bool>,
        connected: Option<bool>,
        running: Option<bool>,
        linked: Option<bool>,
        last_error: Option<String>,
        name: Option<String>,
        last_connected_at: Option<Option<u64>>,
        last_inbound_at: Option<Option<u64>>,
        last_outbound_at: Option<Option<u64>>,
        last_probe_at: Option<Option<u64>>,
        probe: Option<ChannelProbeSnapshot>,
    ) -> Self {
        Self {
            account_id,
            configured,
            connected,
            running,
            linked,
            last_error,
            name,
            last_connected_at,
            last_inbound_at,
            last_outbound_at,
            last_probe_at,
            probe,
        }
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn configured(&self) -> Option<bool> {
        self.configured
    }

    pub fn connected(&self) -> Option<bool> {
        self.connected
    }

    pub fn running(&self) -> Option<bool> {
        self.running
    }

    pub fn linked(&self) -> Option<bool> {
        self.linked
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub fn last_connected_at(&self) -> Option<Option<u64>> {
        self.last_connected_at
    }

    pub fn last_inbound_at(&self) -> Option<Option<u64>> {
        self.last_inbound_at
    }

    pub fn last_outbound_at(&self) -> Option<Option<u64>> {
        self.last_outbound_at
    }

    pub fn last_probe_at(&self) -> Option<Option<u64>> {
        self.last_probe_at
    }

    pub fn probe(&self) -> Option<&ChannelProbeSnapshot> {
        self.probe.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelProbeSnapshot {
    ok: bool,
}

impl ChannelProbeSnapshot {
    pub const fn new(ok: bool) -> Self {
        Self { ok }
    }

    pub const fn ok(&self) -> bool {
        self.ok
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelStatusFailure {
    Rejected,
    Unavailable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_list_serializes_only_safe_source_backed_fields() {
        let payload = serde_json::to_value(ChannelPairingList::new(vec![ChannelPairingRequest {
            id: "sender-1".into(),
            created_at: "2026-08-07T00:00:00.000Z".into(),
            last_seen_at: "2026-08-07T00:01:00.000Z".into(),
            meta: Some(ChannelPairingRequestMeta::new("main".into())),
            status: ChannelPairingRequestStatus::Pending,
        }]))
        .unwrap();

        assert_eq!(
            payload,
            serde_json::json!({
                "requests": [{
                    "id": "sender-1",
                    "createdAt": "2026-08-07T00:00:00.000Z",
                    "lastSeenAt": "2026-08-07T00:01:00.000Z",
                    "meta": { "accountId": "main" },
                    "status": "pending"
                }]
            })
        );
    }
}
