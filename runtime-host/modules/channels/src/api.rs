use foundation::execution::OwnerRuntimeHandle;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::{
    application::{
        call::{ChannelCall, ChannelCallDetail, ChannelCallOperation, ChannelCallOutcome, record_error},
        commands::{ChannelCommand, ChannelOwnerUnavailable},
        queries::ChannelQuery,
        trace::CommandTrace,
    },
    domain::{
        catalog::{ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome},
        control::ChannelControlAction,
        login::Outcome as ChannelLoginOutcome,
        operations::ChannelKey,
        status::{
            ChannelPairingApprovalOutcome, ChannelPairingOutcome, ChannelSnapshotOutcome,
            ChannelStatusFailure, ChannelStatusOutcome,
        },
    },
    projection::config_read as channel_config_read,
};

pub(crate) enum ConfigureDelivery {
    Outcome(ChannelConfigureOutcome),
    Accepted(platform::call::CallReceipt),
}

pub(crate) enum ControlDelivery {
    Outcome(crate::domain::control::ChannelControlOutcome),
    Accepted(platform::call::CallReceipt),
}

#[derive(Clone)]
pub struct ChannelHandle {
    owner: OwnerRuntimeHandle<ChannelCommand, ChannelQuery>,
    recorder: Option<platform::call::CallRecorder>,
}

impl ChannelHandle {
    pub fn new(owner: OwnerRuntimeHandle<ChannelCommand, ChannelQuery>) -> Self {
        Self { owner, recorder: None }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    async fn trace(&self, detail: ChannelCallDetail) -> Result<CommandTrace, ChannelOwnerUnavailable> {
        let mut trace = CommandTrace::capture();
        if let Some(recorder) = &self.recorder {
            let context = recorder.begin(detail.operation.command(), &detail).await.map_err(|_| ChannelOwnerUnavailable)?;
            trace.call = Some(ChannelCall::new(context, detail));
        }
        Ok(trace)
    }

    async fn send_command(&self, command: ChannelCommand) -> Result<(), ChannelOwnerUnavailable> {
        let call = command.trace().and_then(|trace| trace.call.clone());
        let delivered = if call.is_some()
            && matches!(
                &command,
                ChannelCommand::Configure { .. }
                    | ChannelCommand::Delete { .. }
                    | ChannelCommand::Logout { .. }
                    | ChannelCommand::Control {
                        action: ChannelControlAction::Disconnect,
                        ..
                    }
            ) {
            self.owner.try_send_command(command)
        } else {
            self.owner.send_command(command).await
        };
        if delivered.is_err() {
            if let Some(mut call) = call {
                record_error(call.finish(ChannelCallOutcome::Rejected).await);
            }
            return Err(ChannelOwnerUnavailable);
        }
        if let Some(call) = call {
            call.accepted().await.map_err(|_| ChannelOwnerUnavailable)?;
        }
        Ok(())
    }

    async fn send_query(&self, query: ChannelQuery) -> Result<(), ChannelOwnerUnavailable> {
        let call = query.trace().call.clone();
        if self.owner.send_query(query).await.is_err() {
            if let Some(mut call) = call {
                record_error(call.finish(ChannelCallOutcome::Rejected).await);
            }
            return Err(ChannelOwnerUnavailable);
        }
        if let Some(call) = call {
            call.accepted().await.map_err(|_| ChannelOwnerUnavailable)?;
        }
        Ok(())
    }

    pub async fn catalog(&self) -> ChannelCatalogOutcome {
        let trace = match self.trace(ChannelCallDetail::new(ChannelCallOperation::Catalog, None, None)).await {
            Ok(trace) => trace,
            Err(_) => return ChannelCatalogOutcome::Unknown,
        };
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .send_query(ChannelQuery::Catalog {
                trace,
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
        let trace = match self.trace(ChannelCallDetail::new(ChannelCallOperation::ConfigureForm, Some(channel_id.clone()), None)).await {
            Ok(trace) => trace,
            Err(_) => return ChannelConfigureFormOutcome::Unknown,
        };
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .send_query(ChannelQuery::ConfigureForm {
                trace,
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
        let trace = match self.trace(ChannelCallDetail::new(ChannelCallOperation::ConfigRead, Some(channel_id.clone()), account_id.clone())).await {
            Ok(trace) => trace,
            Err(_) => return channel_config_read::Outcome::Unavailable,
        };
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .send_query(ChannelQuery::ConfigRead {
                trace,
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
    ) -> Result<ConfigureDelivery, ChannelOwnerUnavailable> {
        let trace = self.trace(ChannelCallDetail::keyed(ChannelCallOperation::Configure, &key)).await?;
        let call = trace.call.clone();
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self
            .send_command(ChannelCommand::Configure {
                trace,
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
        if let Some(call) = call {
            return Ok(ConfigureDelivery::Accepted(platform::call::CallReceipt { call_id: call.context.id().clone(), accepted: true }));
        }
        reply_rx.await.map_err(|_| {
            platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
            ChannelOwnerUnavailable
        })?.map(ConfigureDelivery::Outcome)
    }

    pub async fn delete_config(
        &self,
        key: ChannelKey,
    ) -> Result<platform::call::CallReceipt, ChannelOwnerUnavailable> {
        let trace = self.trace(ChannelCallDetail::keyed(ChannelCallOperation::DeleteConfig, &key)).await?;
        let call = trace.call.clone().ok_or(ChannelOwnerUnavailable)?;
        let (reply, _reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(ChannelCommand::Delete { trace, key, reply }).await?;
        call.accepted().await.map_err(|_| ChannelOwnerUnavailable)
    }

    pub async fn control(
        &self,
        key: ChannelKey,
        action: ChannelControlAction,
    ) -> Result<ControlDelivery, ChannelOwnerUnavailable> {
        let trace = self
            .trace(ChannelCallDetail::keyed(
                match action {
                    ChannelControlAction::Connect => ChannelCallOperation::Connect,
                    ChannelControlAction::Disconnect => ChannelCallOperation::Disconnect,
                },
                &key,
            ))
            .await?;
        let admission = if action == ChannelControlAction::Disconnect {
            Some(trace.call.clone().ok_or(ChannelOwnerUnavailable)?)
        } else {
            None
        };
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self
            .send_command(ChannelCommand::Control {
                trace,
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
        if let Some(call) = admission {
            return call
                .accepted()
                .await
                .map(ControlDelivery::Accepted)
                .map_err(|_| ChannelOwnerUnavailable);
        }
        reply_rx
            .await
            .map_err(|_| {
                platform::trace::channel_trace("channel.owner.delivery", "outcome=owner_unavailable");
                ChannelOwnerUnavailable
            })?
            .map(ControlDelivery::Outcome)
    }

    pub async fn login_start(
        &self,
        key: ChannelKey,
        force: bool,
        timeout_ms: Option<u64>,
        agent_id: Option<String>,
        config: Zeroizing<Vec<u8>>,
    ) -> Result<(ChannelLoginOutcome, Option<platform::call::CallId>), ChannelOwnerUnavailable> {
        let trace = self.trace(ChannelCallDetail::keyed(ChannelCallOperation::LoginStart, &key)).await?;
        let call_id = trace.call.as_ref().map(|call| call.context.id().clone());
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self
            .send_command(ChannelCommand::LoginStart {
                trace,
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
        })?.map(|outcome| (outcome, call_id))
    }

    pub async fn login_wait(
        &self,
        key: ChannelKey,
        timeout_ms: Option<u64>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: CancellationToken,
    ) -> Result<(ChannelLoginOutcome, Option<platform::call::CallId>), ChannelOwnerUnavailable> {
        let trace = self.trace(ChannelCallDetail::keyed(ChannelCallOperation::LoginWait, &key)).await?;
        let call_id = trace.call.as_ref().map(|call| call.context.id().clone());
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self
            .send_command(ChannelCommand::LoginWait {
                trace,
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
        })?.map(|outcome| (outcome, call_id))
    }

    pub async fn cancel_login(
        &self,
        key: ChannelKey,
    ) -> Result<ChannelLoginOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self
            .send_command(ChannelCommand::LoginCancel {
                trace: self.trace(ChannelCallDetail::keyed(ChannelCallOperation::LoginCancel, &key)).await?,
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
    ) -> Result<platform::call::CallReceipt, ChannelOwnerUnavailable> {
        let trace = self
            .trace(ChannelCallDetail::keyed(ChannelCallOperation::Logout, &key))
            .await?;
        let call = trace.call.clone().ok_or(ChannelOwnerUnavailable)?;
        let (reply, _reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(ChannelCommand::Logout { trace, key, reply })
            .await?;
        call.accepted().await.map_err(|_| ChannelOwnerUnavailable)
    }

    pub async fn approve_pairing(
        &self,
        key: ChannelKey,
        code: Zeroizing<Vec<u8>>,
    ) -> Result<ChannelPairingApprovalOutcome, ChannelOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self
            .send_command(ChannelCommand::PairingApprove {
                trace: self.trace(ChannelCallDetail::keyed(ChannelCallOperation::PairingApprove, &key)).await?,
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
        let trace = match self.trace(ChannelCallDetail::new(ChannelCallOperation::PairingList, Some(channel_id.clone()), account_id.clone())).await {
            Ok(trace) => trace,
            Err(_) => return ChannelPairingOutcome::OutcomeUnknown,
        };
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .send_query(ChannelQuery::Pairing {
                trace,
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
        let trace = match self.trace(ChannelCallDetail::new(ChannelCallOperation::Status, None, None)).await {
            Ok(trace) => trace,
            Err(_) => return Err(ChannelStatusFailure::Unavailable),
        };
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .send_query(ChannelQuery::Status {
                trace,
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
        let trace = match self.trace(ChannelCallDetail::new(ChannelCallOperation::Snapshot, None, None)).await {
            Ok(trace) => trace,
            Err(_) => return Err(ChannelStatusFailure::Unavailable),
        };
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self
            .send_query(ChannelQuery::Snapshot {
                trace,
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
        self
            .send_command(ChannelCommand::ValidateCredentials {
                trace: self.trace(ChannelCallDetail::keyed(ChannelCallOperation::ValidateCredentials, &key)).await?,
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
