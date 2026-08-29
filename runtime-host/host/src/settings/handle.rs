use foundation::execution::OwnerRuntimeHandle;

use super::{SettingsCommand, SettingsQuery, desired};

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
        desired: desired::Desired,
    ) -> desired::Settlement {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_command(SettingsCommand::Replace {
                correlation,
                desired,
                reply: tx,
            })
            .await
            .is_err()
        {
            return desired::Settlement::unknown(0);
        }
        rx.await.unwrap_or(desired::Settlement::unknown(0))
    }

    pub(crate) async fn recover_pending(&self) -> Option<desired::Settlement> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_command(SettingsCommand::RecoverPending { reply: tx })
            .await
            .is_err()
        {
            return None;
        }
        rx.await.unwrap_or(None)
    }

    pub(crate) async fn apply_saved_projection(&self) -> desired::Outcome {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_command(SettingsCommand::ApplySavedProjection { reply: tx })
            .await
            .is_err()
        {
            return desired::Outcome::Unknown;
        }
        rx.await.unwrap_or(desired::Outcome::Unknown)
    }

    pub(crate) async fn pending(&self) -> Option<desired::PendingDesired> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_query(SettingsQuery::Pending { reply: tx })
            .await
            .is_err()
        {
            return None;
        }
        rx.await.unwrap_or(None)
    }

    pub(crate) async fn desired_snapshot(&self) -> desired::PublicDesiredSnapshot {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self
            .inner
            .send_query(SettingsQuery::DesiredSnapshot { reply: tx })
            .await
            .is_err()
        {
            return desired::PublicDesiredSnapshot::default();
        }
        rx.await
            .unwrap_or_else(|_| desired::PublicDesiredSnapshot::default())
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
