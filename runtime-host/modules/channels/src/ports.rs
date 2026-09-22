use std::{future::Future, pin::Pin};

use platform::endpoint::runtime_address::RuntimeEndpoint;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::{
    catalog::{ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome},
    config_read,
    control::{ChannelControlAction, ChannelControlOutcome},
    credentials, delete,
    login::Outcome as ChannelLoginOutcome,
    status::{
        ChannelPairingApprovalOutcome, ChannelPairingOutcome, ChannelSnapshotOutcome,
        ChannelStatusFailure, ChannelStatusOutcome,
    },
};

pub type ChannelFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type OwnedChannelFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub trait ChannelRuntimeDirectory: Send + Sync {
    fn channel_ops(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn ChannelOps>;
}

pub trait ChannelOps: Send + Sync {
    fn control_channel_account<'a>(
        &'a self,
        action: ChannelControlAction,
        channel: String,
        account: String,
    ) -> ChannelFuture<'a, ChannelControlOutcome>;

    fn start_channel_login<'a>(
        &'a self,
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
    ) -> ChannelFuture<'a, ChannelLoginOutcome>;

    fn wait_channel_login_owned(
        &self,
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: CancellationToken,
    ) -> OwnedChannelFuture<ChannelLoginOutcome>;

    fn stop_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelFuture<'a, ChannelLoginOutcome>;

    fn logout_channel<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelFuture<'a, ChannelLoginOutcome>;

    fn list_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
    ) -> ChannelFuture<'a, ChannelPairingOutcome>;

    fn approve_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
        code: Zeroizing<Vec<u8>>,
    ) -> ChannelFuture<'a, ChannelPairingApprovalOutcome>;

    fn observe_channel_accounts<'a>(
        &'a self,
    ) -> ChannelFuture<'a, Result<ChannelStatusOutcome, ChannelStatusFailure>>;

    fn observe_channel_snapshot<'a>(
        &'a self,
    ) -> ChannelFuture<'a, Result<ChannelSnapshotOutcome, ChannelStatusFailure>>;

    fn read_channel_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelFuture<'a, config_read::Outcome>;

    fn validate_channel_credentials<'a>(
        &'a self,
        channel: String,
        config: Zeroizing<Vec<u8>>,
    ) -> ChannelFuture<'a, credentials::Outcome>;

    fn channel_catalog<'a>(&'a self) -> ChannelFuture<'a, ChannelCatalogOutcome>;

    fn channel_configure_form<'a>(
        &'a self,
        channel: String,
    ) -> ChannelFuture<'a, ChannelConfigureFormOutcome>;

    fn channel_configure<'a>(
        &'a self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: Zeroizing<Vec<u8>>,
    ) -> ChannelFuture<'a, ChannelConfigureOutcome>;

    fn finalize_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: Zeroizing<Vec<u8>>,
    ) -> ChannelFuture<'a, ChannelConfigureOutcome>;

    fn channel_delete_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelFuture<'a, delete::Outcome>;
}
