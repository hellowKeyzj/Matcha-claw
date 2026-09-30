use foundation::execution::OwnerRuntimeHandle;
use platform::call::{CallContext, CallLogError, CallReceipt, CallStatus};

use crate::{
    application::{
        call::{SettingsCallDetail, SettingsCallFailure, SettingsOperation},
        commands::SettingsCommand,
        queries::SettingsQuery,
        receipts::Outcome,
    },
    domain::Desired,
    projection::public::DesiredReadModel,
};

#[derive(Clone)]
pub struct SettingsHandle {
    inner: OwnerRuntimeHandle<SettingsCommand, SettingsQuery>,
}

impl SettingsHandle {
    pub(crate) fn new(inner: OwnerRuntimeHandle<SettingsCommand, SettingsQuery>) -> Self {
        Self { inner }
    }

    pub(crate) async fn replace(
        &self,
        correlation: String,
        desired: Desired,
        call: CallContext<SettingsCallDetail>,
    ) -> Result<CallReceipt, CallLogError> {
        if self
            .inner
            .send_command(SettingsCommand::ReplaceDesired {
                correlation,
                desired,
                call: call.clone(),
            })
            .await
            .is_err()
        {
            let mut detail = SettingsCallDetail::new(SettingsOperation::ReplaceDesired);
            detail.failure = Some(SettingsCallFailure::OwnerUnavailable);
            call.finish(CallStatus::Unknown, &detail).await?;
            return Err(CallLogError::Unavailable);
        }
        call.accepted().await
    }

    pub(crate) async fn recover_pending(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_command(SettingsCommand::RecoverPendingProjection { reply: tx })
            .await
            .is_err()
        {
            return;
        }
        let _ = rx.await;
    }

    pub(crate) async fn apply_saved_projection(&self) -> Outcome {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_command(SettingsCommand::ApplySavedProjection { reply: tx })
            .await
            .is_err()
        {
            return Outcome::Unknown;
        }
        rx.await.unwrap_or(Outcome::Unknown)
    }

    pub(crate) async fn desired_snapshot(
        &self,
        call: CallContext<SettingsCallDetail>,
    ) -> Result<DesiredReadModel, CallLogError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_query(SettingsQuery::DesiredReadModel {
                call: call.clone(),
                reply: tx,
            })
            .await
            .is_err()
        {
            let mut detail = SettingsCallDetail::new(SettingsOperation::ReadCurrent);
            detail.failure = Some(SettingsCallFailure::OwnerUnavailable);
            call.finish(CallStatus::Unknown, &detail).await?;
            return Err(CallLogError::Unavailable);
        }
        call.accepted().await?;
        rx.await.map_err(|_| CallLogError::Unavailable)?
    }

    pub(crate) async fn gateway_auto_start(&self) -> bool {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_query(SettingsQuery::GatewayAutoStart { reply: tx })
            .await
            .is_err()
        {
            return true;
        }
        rx.await.unwrap_or(true)
    }
}
