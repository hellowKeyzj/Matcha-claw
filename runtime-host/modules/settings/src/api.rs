use foundation::execution::OwnerRuntimeHandle;

use crate::{
    application::{
        commands::SettingsCommand,
        queries::SettingsQuery,
        receipts::{Outcome, Settlement},
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

    pub(crate) async fn replace(&self, correlation: String, desired: Desired) -> Settlement {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_command(SettingsCommand::ReplaceDesired {
                correlation,
                desired,
                reply: tx,
            })
            .await
            .is_err()
        {
            return Settlement::unknown(0);
        }
        rx.await.unwrap_or(Settlement::unknown(0))
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

    pub(crate) async fn desired_snapshot(&self) -> DesiredReadModel {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_query(SettingsQuery::DesiredReadModel { reply: tx })
            .await
            .is_err()
        {
            return DesiredReadModel::default();
        }
        rx.await.unwrap_or_else(|_| DesiredReadModel::default())
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
