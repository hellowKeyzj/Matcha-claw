use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

use channels_module::status::{
    ChannelAccountSnapshot, ChannelAccountStatus, ChannelConnection, ChannelSnapshotOutcome,
    ChannelStatusFailure, ChannelStatusOutcome, ChannelSummarySnapshot,
};
use serde_json::{Value, json};

use super::{CHANNEL, Channels, Failure};

const PUBLIC_STATUS_ERROR: &str = "Channel status reported an error";

impl Channels {
    pub(super) async fn accounts(&self) -> Result<ChannelStatusOutcome, ChannelStatusFailure> {
        let snapshot = self.snapshot().await?;
        Ok(ChannelStatusOutcome::new(
            snapshot
                .channel_accounts()
                .get(CHANNEL)
                .into_iter()
                .flatten()
                .map(|account| {
                    ChannelAccountStatus::new(
                        CHANNEL.into(),
                        account.account_id().into(),
                        ChannelConnection::Unknown,
                    )
                })
                .collect(),
        ))
    }

    pub(super) async fn snapshot(&self) -> Result<ChannelSnapshotOutcome, ChannelStatusFailure> {
        let bindings = self.bindings().await.map_err(|error| match error {
            Failure::Rejected => ChannelStatusFailure::Rejected,
            Failure::Unknown => ChannelStatusFailure::Unavailable,
        })?;
        let configured = !bindings.is_empty();
        let mut accounts = Vec::new();
        let mut partial = false;
        let mut any_running = false;
        let mut all_observed = true;
        for binding in bindings {
            let (running, error) = match self
                .client
                .call("channels.status", json!({"id":binding.id}))
                .await
            {
                Ok(value) => {
                    let running = if value.get("nativeStatusError").is_some() {
                        None
                    } else if binding.definition.session_id.is_none()
                        || (value.get("instanceId") == Some(&Value::Null)
                            && value.get("launching") == Some(&Value::Bool(false)))
                    {
                        Some(false)
                    } else {
                        value
                            .get("nativeServers")
                            .and_then(Value::as_array)
                            .and_then(|servers| {
                                if servers.iter().any(|server| {
                                    server.get("status").and_then(Value::as_str)
                                        == Some("connected")
                                        && server.get("channelCapability")
                                            == Some(&Value::Bool(true))
                                }) {
                                    Some(true)
                                } else if servers.iter().all(|server| {
                                    matches!(
                                        server.get("status").and_then(Value::as_str),
                                        Some("failed" | "needs-auth" | "disabled" | "connected")
                                    )
                                }) {
                                    Some(false)
                                } else {
                                    None
                                }
                            })
                    };
                    let error = value
                        .get("nativeStatusError")
                        .is_some()
                        .then(|| PUBLIC_STATUS_ERROR.to_owned());
                    (running, error)
                }
                Err(_) => (None, Some(PUBLIC_STATUS_ERROR.into())),
            };
            partial |= error.is_some() || running.is_none();
            any_running |= running == Some(true);
            all_observed &= running.is_some();
            // Channel-capable MCP transport is observable; polling, account health and connectivity are not.
            accounts.push(ChannelAccountSnapshot::new(
                binding.id,
                Some(true),
                None,
                running,
                None,
                error,
                None,
                None,
                None,
                None,
                None,
                None,
            ));
        }
        let error = partial.then(|| PUBLIC_STATUS_ERROR.into());
        let summary = ChannelSummarySnapshot::new(
            Some(configured),
            if any_running {
                Some(true)
            } else if all_observed {
                Some(false)
            } else {
                None
            },
            error.clone(),
            None,
        );
        Ok(ChannelSnapshotOutcome::new(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            true,
            false,
            error,
            vec![CHANNEL.into()],
            BTreeMap::from([(CHANNEL.into(), summary)]),
            BTreeMap::from([(CHANNEL.into(), accounts)]),
            BTreeMap::new(),
        ))
    }
}
