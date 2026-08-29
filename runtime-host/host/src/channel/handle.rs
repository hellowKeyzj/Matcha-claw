use foundation::execution::OwnerRuntimeHandle;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::{
    ChannelKey,
    catalog::{ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome},
    command::{ChannelCommand, ChannelOwnerUnavailable, ChannelQuery},
    config_read as channel_config_read,
    control::ChannelControlAction,
    delete as channel_delete,
    login::Outcome as ChannelLoginOutcome,
    status::{
        ChannelPairingApprovalOutcome, ChannelPairingOutcome, ChannelSnapshotOutcome,
        ChannelStatusFailure, ChannelStatusOutcome,
    },
};

#[derive(Clone)]
pub(crate) struct ChannelHandle {
    owner: OwnerRuntimeHandle<ChannelCommand, ChannelQuery>,
}

impl ChannelHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<ChannelCommand, ChannelQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn catalog(&self) -> ChannelCatalogOutcome {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::Catalog { reply })
            .await
            .is_err()
        {
            return ChannelCatalogOutcome::Unknown;
        }
        reply_rx.await.unwrap_or(ChannelCatalogOutcome::Unknown)
    }

    pub(crate) async fn configure_form(&self, channel_id: String) -> ChannelConfigureFormOutcome {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::ConfigureForm { channel_id, reply })
            .await
            .is_err()
        {
            return ChannelConfigureFormOutcome::Unknown;
        }
        reply_rx
            .await
            .unwrap_or(ChannelConfigureFormOutcome::Unknown)
    }

    pub(crate) async fn config(
        &self,
        channel_id: String,
        account_id: Option<String>,
    ) -> channel_config_read::Outcome {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::ConfigRead {
                channel_id,
                account_id,
                reply,
            })
            .await
            .is_err()
        {
            return channel_config_read::Outcome::Unknown;
        }
        reply_rx
            .await
            .unwrap_or(channel_config_read::Outcome::Unknown)
    }

    pub(crate) async fn configure(
        &self,
        key: ChannelKey,
        values: Zeroizing<Vec<u8>>,
    ) -> Result<ChannelConfigureOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::Configure { key, values, reply })
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)?
    }

    pub(crate) async fn delete_config(
        &self,
        key: ChannelKey,
    ) -> Result<channel_delete::Outcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::Delete { key, reply })
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)?
    }

    pub(crate) async fn control(
        &self,
        key: ChannelKey,
        action: ChannelControlAction,
    ) -> Result<crate::channel::control::ChannelControlOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::Control { key, action, reply })
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)?
    }

    pub(crate) async fn login_start(
        &self,
        key: ChannelKey,
        force: bool,
        timeout_ms: Option<u64>,
        config: Zeroizing<Vec<u8>>,
    ) -> Result<ChannelLoginOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::LoginStart {
                key,
                force,
                timeout_ms,
                config,
                reply,
            })
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)?
    }

    pub(crate) async fn login_wait(
        &self,
        key: ChannelKey,
        timeout_ms: Option<u64>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: CancellationToken,
    ) -> Result<ChannelLoginOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::LoginWait {
                key,
                timeout_ms,
                session_key,
                current_qr_data_url,
                cancellation,
                reply,
            })
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)?
    }

    pub(crate) async fn cancel_login(
        &self,
        key: ChannelKey,
    ) -> Result<ChannelLoginOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::LoginCancel { key, reply })
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)?
    }

    pub(crate) async fn logout(
        &self,
        key: ChannelKey,
    ) -> Result<ChannelLoginOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::Logout { key, reply })
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)?
    }

    pub(crate) async fn approve_pairing(
        &self,
        key: ChannelKey,
        code: Zeroizing<Vec<u8>>,
    ) -> Result<ChannelPairingApprovalOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::PairingApprove { key, code, reply })
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)?
    }

    pub(crate) async fn pairing(
        &self,
        channel_id: String,
        account_id: Option<String>,
    ) -> ChannelPairingOutcome {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::Pairing {
                channel_id,
                account_id,
                reply,
            })
            .await
            .is_err()
        {
            return ChannelPairingOutcome::OutcomeUnknown;
        }
        reply_rx
            .await
            .unwrap_or(ChannelPairingOutcome::OutcomeUnknown)
    }

    pub(crate) async fn status(&self) -> Result<ChannelStatusOutcome, ChannelStatusFailure> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::Status { reply })
            .await
            .is_err()
        {
            return Err(ChannelStatusFailure::Unavailable);
        }
        reply_rx
            .await
            .unwrap_or(Err(ChannelStatusFailure::Unavailable))
    }

    pub(crate) async fn snapshot(&self) -> Result<ChannelSnapshotOutcome, ChannelStatusFailure> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::Snapshot { reply })
            .await
            .is_err()
        {
            return Err(ChannelStatusFailure::Unavailable);
        }
        reply_rx
            .await
            .unwrap_or(Err(ChannelStatusFailure::Unavailable))
    }

    pub(crate) async fn validate_credentials(
        &self,
        key: ChannelKey,
        config: Zeroizing<Vec<u8>>,
    ) -> Result<crate::channel::credentials::Outcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::ValidateCredentials { key, config, reply })
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)?
    }

    pub(crate) async fn shutdown(&self) -> Result<(), ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::Shutdown(reply))
            .await
            .map_err(|_| ChannelOwnerUnavailable)?;
        reply_rx.await.map_err(|_| ChannelOwnerUnavailable)
    }
}
