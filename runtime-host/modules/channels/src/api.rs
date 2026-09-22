use foundation::execution::OwnerRuntimeHandle;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::{
    application::{
        commands::{ChannelCommand, ChannelOwnerUnavailable},
        queries::ChannelQuery,
        trace::CommandTrace,
    },
    domain::{
        catalog::{ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome},
        control::ChannelControlAction,
        delete as channel_delete,
        login::Outcome as ChannelLoginOutcome,
        operations::ChannelKey,
        status::{
            ChannelPairingApprovalOutcome, ChannelPairingOutcome, ChannelSnapshotOutcome,
            ChannelStatusFailure, ChannelStatusOutcome,
        },
    },
    projection::config_read as channel_config_read,
};

#[derive(Clone)]
pub struct ChannelHandle {
    owner: OwnerRuntimeHandle<ChannelCommand, ChannelQuery>,
}

impl ChannelHandle {
    pub fn new(owner: OwnerRuntimeHandle<ChannelCommand, ChannelQuery>) -> Self {
        Self { owner }
    }

    pub async fn catalog(&self) -> ChannelCatalogOutcome {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::Catalog {
                trace: CommandTrace::capture(),
                reply,
            })
            .await
            .is_err()
        {
            return ChannelCatalogOutcome::Unknown;
        }
        reply_rx.await.unwrap_or(ChannelCatalogOutcome::Unknown)
    }

    pub async fn configure_form(&self, channel_id: String) -> ChannelConfigureFormOutcome {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::ConfigureForm {
                trace: CommandTrace::capture(),
                channel_id,
                reply,
            })
            .await
            .is_err()
        {
            return ChannelConfigureFormOutcome::Unknown;
        }
        reply_rx
            .await
            .unwrap_or(ChannelConfigureFormOutcome::Unknown)
    }

    pub async fn config(
        &self,
        channel_id: String,
        account_id: Option<String>,
    ) -> channel_config_read::Outcome {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::ConfigRead {
                trace: CommandTrace::capture(),
                channel_id,
                account_id,
                reply,
            })
            .await
            .is_err()
        {
            return channel_config_read::Outcome::Unavailable;
        }
        reply_rx
            .await
            .unwrap_or(channel_config_read::Outcome::Unavailable)
    }

    pub async fn configure(
        &self,
        key: ChannelKey,
        agent_id: Option<String>,
        values: Zeroizing<Vec<u8>>,
    ) -> Result<ChannelConfigureOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::Configure {
                trace: CommandTrace::capture(),
                key,
                agent_id,
                values,
                reply,
            })
            .await
            .map_err(|_| {
                platform::trace::channel_trace(
                    "channel.owner.delivery",
                    "outcome=owner_unavailable",
                );
                ChannelOwnerUnavailable
            })?;
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?
    }

    pub async fn delete_config(
        &self,
        key: ChannelKey,
    ) -> Result<channel_delete::Outcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::Delete {
                trace: CommandTrace::capture(),
                key,
                reply,
            })
            .await
            .map_err(|_| {
                platform::trace::channel_trace(
                    "channel.owner.delivery",
                    "outcome=owner_unavailable",
                );
                ChannelOwnerUnavailable
            })?;
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?
    }

    pub async fn control(
        &self,
        key: ChannelKey,
        action: ChannelControlAction,
    ) -> Result<crate::domain::control::ChannelControlOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::Control {
                trace: CommandTrace::capture(),
                key,
                action,
                reply,
            })
            .await
            .map_err(|_| {
                platform::trace::channel_trace(
                    "channel.owner.delivery",
                    "outcome=owner_unavailable",
                );
                ChannelOwnerUnavailable
            })?;
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?
    }

    pub async fn login_start(
        &self,
        key: ChannelKey,
        force: bool,
        timeout_ms: Option<u64>,
        agent_id: Option<String>,
        config: Zeroizing<Vec<u8>>,
    ) -> Result<ChannelLoginOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::LoginStart {
                trace: CommandTrace::capture(),
                key,
                force,
                timeout_ms,
                agent_id,
                config,
                reply,
            })
            .await
            .map_err(|_| {
                platform::trace::channel_trace(
                    "channel.owner.delivery",
                    "outcome=owner_unavailable",
                );
                ChannelOwnerUnavailable
            })?;
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?
    }

    pub async fn login_wait(
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
                trace: CommandTrace::capture(),
                key,
                timeout_ms,
                session_key,
                current_qr_data_url,
                cancellation,
                reply,
            })
            .await
            .map_err(|_| {
                platform::trace::channel_trace(
                    "channel.owner.delivery",
                    "outcome=owner_unavailable",
                );
                ChannelOwnerUnavailable
            })?;
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?
    }

    pub async fn cancel_login(
        &self,
        key: ChannelKey,
    ) -> Result<ChannelLoginOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::LoginCancel {
                trace: CommandTrace::capture(),
                key,
                reply,
            })
            .await
            .map_err(|_| {
                platform::trace::channel_trace(
                    "channel.owner.delivery",
                    "outcome=owner_unavailable",
                );
                ChannelOwnerUnavailable
            })?;
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?
    }

    pub async fn logout(
        &self,
        key: ChannelKey,
    ) -> Result<ChannelLoginOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::Logout {
                trace: CommandTrace::capture(),
                key,
                reply,
            })
            .await
            .map_err(|_| {
                platform::trace::channel_trace(
                    "channel.owner.delivery",
                    "outcome=owner_unavailable",
                );
                ChannelOwnerUnavailable
            })?;
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?
    }

    pub async fn approve_pairing(
        &self,
        key: ChannelKey,
        code: Zeroizing<Vec<u8>>,
    ) -> Result<ChannelPairingApprovalOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::PairingApprove {
                trace: CommandTrace::capture(),
                key,
                code,
                reply,
            })
            .await
            .map_err(|_| {
                platform::trace::channel_trace(
                    "channel.owner.delivery",
                    "outcome=owner_unavailable",
                );
                ChannelOwnerUnavailable
            })?;
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?
    }

    pub async fn pairing(
        &self,
        channel_id: String,
        account_id: Option<String>,
    ) -> ChannelPairingOutcome {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::Pairing {
                trace: CommandTrace::capture(),
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

    pub async fn status(&self) -> Result<ChannelStatusOutcome, ChannelStatusFailure> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::Status {
                trace: CommandTrace::capture(),
                reply,
            })
            .await
            .is_err()
        {
            return Err(ChannelStatusFailure::Unavailable);
        }
        reply_rx
            .await
            .unwrap_or(Err(ChannelStatusFailure::Unavailable))
    }

    pub async fn snapshot(&self) -> Result<ChannelSnapshotOutcome, ChannelStatusFailure> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .owner
            .send_query(ChannelQuery::Snapshot {
                trace: CommandTrace::capture(),
                reply,
            })
            .await
            .is_err()
        {
            return Err(ChannelStatusFailure::Unavailable);
        }
        reply_rx
            .await
            .unwrap_or(Err(ChannelStatusFailure::Unavailable))
    }

    pub async fn validate_credentials(
        &self,
        key: ChannelKey,
        config: Zeroizing<Vec<u8>>,
    ) -> Result<crate::domain::credentials::Outcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(ChannelCommand::ValidateCredentials {
                trace: CommandTrace::capture(),
                key,
                config,
                reply,
            })
            .await
            .map_err(|_| {
                platform::trace::channel_trace(
                    "channel.owner.delivery",
                    "outcome=owner_unavailable",
                );
                ChannelOwnerUnavailable
            })?;
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?
    }
}
