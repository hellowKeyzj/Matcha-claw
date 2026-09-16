use foundation::execution::OwnerRuntimeHandle;

use environment::settings;

use super::{command::SettingsCommand, query::SettingsQuery, read_model::DesiredReadModel};

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
        desired: settings::Desired,
    ) -> settings::Settlement {
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
            return settings::Settlement::unknown(0);
        }
        rx.await.unwrap_or(settings::Settlement::unknown(0))
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

    pub(crate) async fn apply_saved_projection(&self) -> settings::Outcome {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_command(SettingsCommand::ApplySavedProjection { reply: tx })
            .await
            .is_err()
        {
            return settings::Outcome::Unknown;
        }
        rx.await.unwrap_or(settings::Outcome::Unknown)
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
