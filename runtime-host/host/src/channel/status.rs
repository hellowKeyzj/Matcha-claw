use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelPairingRequest {
    pub(crate) id: String,
    pub(crate) created_at: String,
    pub(crate) last_seen_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) meta: Option<ChannelPairingRequestMeta>,
    pub(crate) status: ChannelPairingRequestStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelPairingRequestMeta {
    account_id: String,
}

impl ChannelPairingRequestMeta {
    pub(crate) fn new(account_id: String) -> Self {
        Self { account_id }
    }

    pub(crate) fn account_id(&self) -> &str {
        &self.account_id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChannelPairingRequestStatus {
    Pending,
    Unknown,
}

impl ChannelPairingRequestStatus {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ChannelPairingList {
    requests: Vec<ChannelPairingRequest>,
}

impl ChannelPairingList {
    pub(crate) fn new(requests: Vec<ChannelPairingRequest>) -> Self {
        Self { requests }
    }

    pub(crate) fn requests(&self) -> &[ChannelPairingRequest] {
        &self.requests
    }
}

impl ChannelPairingRequest {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn created_at(&self) -> &str {
        &self.created_at
    }

    pub(crate) fn last_seen_at(&self) -> &str {
        &self.last_seen_at
    }

    pub(crate) fn meta(&self) -> Option<&ChannelPairingRequestMeta> {
        self.meta.as_ref()
    }

    pub(crate) fn status(&self) -> ChannelPairingRequestStatus {
        self.status
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChannelPairingOutcome {
    Listed(Vec<ChannelPairingRequest>),
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChannelPairingApprovalOutcome {
    Confirmed,
    TargetRejected,
    Unknown,
}

impl ChannelPairingApprovalOutcome {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::TargetRejected => "target_rejected",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelAccountStatus {
    channel: String,
    account_id: String,
    connection: ChannelConnection,
}

impl ChannelAccountStatus {
    pub(crate) fn new(channel: String, account_id: String, connection: ChannelConnection) -> Self {
        Self {
            channel,
            account_id,
            connection,
        }
    }

    pub(crate) fn channel(&self) -> &str {
        &self.channel
    }

    pub(crate) fn account_id(&self) -> &str {
        &self.account_id
    }

    pub(crate) fn connection(&self) -> ChannelConnection {
        self.connection
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChannelConnection {
    Connected,
    Disconnected,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelStatusOutcome {
    accounts: Vec<ChannelAccountStatus>,
}

impl ChannelStatusOutcome {
    pub(crate) fn new(accounts: Vec<ChannelAccountStatus>) -> Self {
        Self { accounts }
    }

    pub(crate) fn accounts(&self) -> &[ChannelAccountStatus] {
        &self.accounts
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelSnapshotOutcome {
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
    pub(crate) fn new(
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

    pub(crate) fn ts(&self) -> u64 {
        self.ts
    }

    pub(crate) fn ready(&self) -> bool {
        self.ready
    }

    pub(crate) fn refreshing(&self) -> bool {
        self.refreshing
    }

    pub(crate) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub(crate) fn channel_order(&self) -> &[String] {
        &self.channel_order
    }

    pub(crate) fn channels(&self) -> &BTreeMap<String, ChannelSummarySnapshot> {
        &self.channels
    }

    pub(crate) fn channel_accounts(&self) -> &BTreeMap<String, Vec<ChannelAccountSnapshot>> {
        &self.channel_accounts
    }

    pub(crate) fn channel_default_account_id(&self) -> &BTreeMap<String, String> {
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
pub(crate) struct ChannelSummarySnapshot {
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
    pub(crate) fn new(
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

    pub(crate) fn configured(&self) -> Option<bool> {
        self.configured
    }

    pub(crate) fn running(&self) -> Option<bool> {
        self.running
    }

    pub(crate) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub(crate) fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelAccountSnapshot {
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
    pub(crate) fn new(
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

    pub(crate) fn account_id(&self) -> &str {
        &self.account_id
    }

    pub(crate) fn configured(&self) -> Option<bool> {
        self.configured
    }

    pub(crate) fn connected(&self) -> Option<bool> {
        self.connected
    }

    pub(crate) fn running(&self) -> Option<bool> {
        self.running
    }

    pub(crate) fn linked(&self) -> Option<bool> {
        self.linked
    }

    pub(crate) fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub(crate) fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub(crate) fn last_connected_at(&self) -> Option<Option<u64>> {
        self.last_connected_at
    }

    pub(crate) fn last_inbound_at(&self) -> Option<Option<u64>> {
        self.last_inbound_at
    }

    pub(crate) fn last_outbound_at(&self) -> Option<Option<u64>> {
        self.last_outbound_at
    }

    pub(crate) fn last_probe_at(&self) -> Option<Option<u64>> {
        self.last_probe_at
    }

    pub(crate) fn probe(&self) -> Option<&ChannelProbeSnapshot> {
        self.probe.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelProbeSnapshot {
    ok: bool,
}

impl ChannelProbeSnapshot {
    pub(crate) const fn new(ok: bool) -> Self {
        Self { ok }
    }

    pub(crate) const fn ok(&self) -> bool {
        self.ok
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChannelStatusFailure {
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
