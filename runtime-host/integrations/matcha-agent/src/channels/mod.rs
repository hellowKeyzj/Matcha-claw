mod config;
mod login;
mod status;

use channels_module::{
    catalog::{ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome},
    config_read,
    control::{ChannelControlAction, ChannelControlOutcome},
    credentials, delete,
    login::Outcome,
    ports::{ChannelFuture, ChannelOps, OwnedChannelFuture},
    status::{
        ChannelPairingApprovalOutcome, ChannelPairingOutcome, ChannelSnapshotOutcome,
        ChannelStatusFailure, ChannelStatusOutcome,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::client::{Client, Delivery, Error};

const CHANNEL: &str = "weixin";
const SOURCE: &str = "plugin:weixin@builtin";

#[derive(Clone)]
pub struct Channels {
    client: Client,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    agent_id: String,
    enabled: bool,
    source: String,
    session_id: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Binding {
    id: String,
    definition: Definition,
}

#[derive(Clone, Copy)]
enum Failure {
    Rejected,
    Unknown,
}

fn failure(error: &Error) -> Failure {
    if error.data().is_some_and(|data| {
        matches!(
            data.get("outcome").and_then(Value::as_str),
            Some("partial" | "unknown")
        ) || data.get("cleanupError").is_some()
            || data.get("cleanupFailures").is_some()
            || data.get("delivery").and_then(Value::as_str) == Some("unknown")
    }) {
        return Failure::Unknown;
    }
    if error.delivery() == Delivery::NotSent
        || (error.delivery() == Delivery::ResponseReceived
            && matches!(error.code(), Some(-32602 | -32001 | -32002)))
    {
        Failure::Rejected
    } else {
        Failure::Unknown
    }
}

impl Channels {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    async fn bindings(&self) -> Result<Vec<Binding>, Failure> {
        let value = self
            .client
            .call("channels.list", json!({}))
            .await
            .map_err(|error| failure(&error))?;
        let bindings: Vec<Binding> =
            serde_json::from_value(value.get("channels").cloned().ok_or(Failure::Unknown)?)
                .map_err(|_| Failure::Unknown)?;
        if bindings
            .iter()
            .any(|binding| binding.definition.source != SOURCE)
        {
            return Err(Failure::Unknown);
        }
        Ok(bindings)
    }

    async fn binding(&self, channel: &str, account: Option<&str>) -> Result<Binding, Failure> {
        if channel != CHANNEL {
            return Err(Failure::Rejected);
        }
        let bindings = self.bindings().await?;
        let mut selected = bindings
            .into_iter()
            .filter(|binding| account.is_none_or(|id| binding.id == id));
        let binding = selected.next().ok_or(Failure::Rejected)?;
        if selected.next().is_some() {
            return Err(Failure::Rejected);
        }
        Ok(binding)
    }
}

impl ChannelOps for Channels {
    fn control_channel_account<'a>(
        &'a self,
        action: ChannelControlAction,
        channel: String,
        account: String,
    ) -> ChannelFuture<'a, ChannelControlOutcome> {
        Box::pin(async move {
            if action == ChannelControlAction::Connect {
                return ChannelControlOutcome::Unsupported;
            }
            let binding = match self.binding(&channel, Some(&account)).await {
                Ok(binding) => binding,
                Err(Failure::Rejected) => return ChannelControlOutcome::Rejected,
                Err(Failure::Unknown) => return ChannelControlOutcome::OutcomeUnknown,
            };
            match self
                .client
                .call("channels.stop", json!({"id":binding.id}))
                .await
            {
                Ok(value) if value.get("stopped") == Some(&Value::Bool(true)) => {
                    ChannelControlOutcome::Confirmed
                }
                Err(error) if matches!(failure(&error), Failure::Rejected) => {
                    ChannelControlOutcome::Rejected
                }
                _ => ChannelControlOutcome::OutcomeUnknown,
            }
        })
    }

    fn start_channel_login<'a>(
        &'a self,
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        agent_id: Option<String>,
        config: Zeroizing<Vec<u8>>,
    ) -> ChannelFuture<'a, Outcome> {
        Box::pin(async move {
            let Some(account) = account_id else {
                return Outcome::Rejected;
            };
            match self
                .configure(channel.clone(), account.clone(), agent_id, config)
                .await
            {
                ChannelConfigureOutcome::Confirmed => {
                    self.start_login(channel, force, timeout_ms, Some(account))
                        .await
                }
                ChannelConfigureOutcome::TargetRejected => Outcome::Rejected,
                ChannelConfigureOutcome::Unknown => Outcome::Unknown,
            }
        })
    }

    fn wait_channel_login_owned(
        &self,
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: CancellationToken,
    ) -> OwnedChannelFuture<Outcome> {
        let channels = self.clone();
        Box::pin(async move {
            channels
                .wait_login(
                    channel,
                    timeout_ms,
                    account_id,
                    session_key,
                    current_qr_data_url,
                    cancellation,
                )
                .await
        })
    }

    fn stop_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelFuture<'a, Outcome> {
        Box::pin(self.cancel_login(channel, account_id, None))
    }

    fn logout_channel<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelFuture<'a, Outcome> {
        Box::pin(async move {
            let binding = match self.binding(&channel, account_id.as_deref()).await {
                Ok(binding) => binding,
                Err(Failure::Rejected) => return Outcome::Rejected,
                Err(Failure::Unknown) => return Outcome::Unknown,
            };
            match self
                .client
                .call("channels.logout", json!({"id":binding.id}))
                .await
            {
                Ok(value)
                    if value.get("cleared") == Some(&Value::Bool(true))
                        && value.get("stopped") == Some(&Value::Bool(true)) =>
                {
                    Outcome::Confirmed
                }
                Err(error) if matches!(failure(&error), Failure::Rejected) => Outcome::Rejected,
                _ => Outcome::Unknown,
            }
        })
    }

    fn list_channel_pairing<'a>(
        &'a self,
        _channel: String,
        _account: Option<String>,
    ) -> ChannelFuture<'a, ChannelPairingOutcome> {
        Box::pin(async { ChannelPairingOutcome::Unsupported })
    }

    fn approve_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
        code: Zeroizing<Vec<u8>>,
    ) -> ChannelFuture<'a, ChannelPairingApprovalOutcome> {
        Box::pin(async move {
            let binding = match self.binding(&channel, account.as_deref()).await {
                Ok(binding) => binding,
                Err(Failure::Rejected) => return ChannelPairingApprovalOutcome::TargetRejected,
                Err(Failure::Unknown) => return ChannelPairingApprovalOutcome::Unknown,
            };
            let Ok(code) = std::str::from_utf8(&code) else {
                return ChannelPairingApprovalOutcome::TargetRejected;
            };
            if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
                return ChannelPairingApprovalOutcome::TargetRejected;
            }
            match self
                .client
                .call("channels.pair", json!({"id":binding.id,"code":code}))
                .await
            {
                Ok(value) if value.get("paired") == Some(&Value::Bool(true)) => {
                    ChannelPairingApprovalOutcome::Confirmed
                }
                Err(error) if matches!(failure(&error), Failure::Rejected) => {
                    ChannelPairingApprovalOutcome::TargetRejected
                }
                _ => ChannelPairingApprovalOutcome::Unknown,
            }
        })
    }

    fn observe_channel_accounts<'a>(
        &'a self,
    ) -> ChannelFuture<'a, Result<ChannelStatusOutcome, ChannelStatusFailure>> {
        Box::pin(self.accounts())
    }

    fn observe_channel_snapshot<'a>(
        &'a self,
    ) -> ChannelFuture<'a, Result<ChannelSnapshotOutcome, ChannelStatusFailure>> {
        Box::pin(self.snapshot())
    }

    fn read_channel_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelFuture<'a, config_read::Outcome> {
        Box::pin(self.read_config(channel, account_id))
    }

    fn validate_channel_credentials<'a>(
        &'a self,
        _channel: String,
        _config: Zeroizing<Vec<u8>>,
    ) -> ChannelFuture<'a, credentials::Outcome> {
        Box::pin(async { credentials::Outcome::Unsupported })
    }

    fn channel_catalog<'a>(&'a self) -> ChannelFuture<'a, ChannelCatalogOutcome> {
        Box::pin(self.catalog())
    }

    fn channel_configure_form<'a>(
        &'a self,
        channel: String,
    ) -> ChannelFuture<'a, ChannelConfigureFormOutcome> {
        Box::pin(async move { config::form(&channel) })
    }

    fn channel_configure<'a>(
        &'a self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: Zeroizing<Vec<u8>>,
    ) -> ChannelFuture<'a, ChannelConfigureOutcome> {
        Box::pin(self.configure(channel, account_id, agent_id, values))
    }

    fn finalize_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: Zeroizing<Vec<u8>>,
    ) -> ChannelFuture<'a, ChannelConfigureOutcome> {
        Box::pin(self.configure(channel, account_id, agent_id, values))
    }

    fn channel_delete_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelFuture<'a, delete::Outcome> {
        Box::pin(async move {
            let binding = match self.binding(&channel, account_id.as_deref()).await {
                Ok(binding) => binding,
                Err(Failure::Rejected) => return delete::Outcome::TargetRejected,
                Err(Failure::Unknown) => return delete::Outcome::Unknown,
            };
            match self
                .client
                .call("channels.delete", json!({"id":binding.id}))
                .await
            {
                Ok(value)
                    if value.get("deleted") == Some(&Value::Bool(true))
                        && value.get("credentialsCleared") == Some(&Value::Bool(true))
                        && value.get("stopped") == Some(&Value::Bool(true)) =>
                {
                    delete::Outcome::Confirmed
                }
                Err(error)
                    if matches!(failure(&error), Failure::Rejected)
                        && error
                            .data()
                            .is_none_or(|data| data.get("outcome").is_none()) =>
                {
                    delete::Outcome::TargetRejected
                }
                _ => delete::Outcome::Unknown,
            }
        })
    }
}
